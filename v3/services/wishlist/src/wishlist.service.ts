import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AuditLogger, insertOnce } from '@beauclick/events';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import {
  WISHLIST_MAX_CURSOR_LENGTH,
  WISHLIST_MAX_PAGE_SIZE,
  WISHLIST_MAX_SAVED_ITEMS,
  WISHLIST_TARGET_TYPES,
} from '@beauclick/wishlist-contract';
import type {
  WishlistItemView,
  WishlistPageView,
  WishlistTargetState,
  WishlistTargetType,
} from '@beauclick/wishlist-contract';

import { WishlistSavedItemEntity } from './entities/wishlist.entities';
import { WishlistLimitReachedException } from './wishlist.exceptions';
import {
  WISHLIST_TARGET_PORT,
  WishlistTargetPort,
  WishlistTargetRef,
  wishlistTargetKey,
} from './ports/wishlist.ports';

/**
 * A namespace for this module's advisory locks.
 *
 * PostgreSQL's advisory-lock space is global to the database, so an unqualified
 * key would collide with any future caller that happened to hash the same user
 * id. The two-argument form takes a namespace and a key; this constant is the
 * namespace, and nothing else in the codebase uses advisory locks today (checked
 * at implementation time), so it is claimed here explicitly rather than left as
 * whatever `hashtext` returns.
 */
const WISHLIST_LOCK_NAMESPACE = 0x77_69_73_68 | 0; // 'wish'

/**
 * The saved list.
 *
 * ## The one interesting problem in this module: the cap
 *
 * `V32-DEC-021` caps a customer at 500 items, and issue #8 requires it
 * "enforced inside the insert transaction rather than by a preceding count".
 * Both obvious implementations are wrong under concurrency, and it is worth
 * being precise about why, because the second one LOOKS atomic:
 *
 *   * `SELECT count(*)` then `INSERT` — two concurrent adds both observe 499 and
 *     both insert. This is `GAP-04` exactly: V2's campaign `record_usage()`
 *     checked the cap well before the insert and overshot both its limits.
 *   * `INSERT ... SELECT ... WHERE (SELECT count(*) ...) < 500` — one statement,
 *     and still wrong. Under `READ COMMITTED` each transaction evaluates the
 *     subquery against a snapshot taken before either insert is visible, so both
 *     still see 499. Collapsing the read and the write into one statement does
 *     not make the read see the other transaction's uncommitted row.
 *
 * So a lock is genuinely required, and the choice of which is recorded in
 * ADR-033 §8. **A transaction-scoped advisory lock keyed on the subject**, taken
 * before the count. Adds serialise per customer — precisely the set the cap is
 * about, the same argument `chat.send_counters` makes for bucketing by minute —
 * and nothing else in the system waits.
 *
 * The alternative, a `wishlist.saved_item_counters` row conditionally
 * incremented in the `ai.usage_daily` shape, is correct too and was rejected for
 * a specific reason rather than a stylistic one: it introduces a denormalised
 * count that must be decremented on every remove and on erasure, and that can
 * drift from the rows it claims to count. `loyalty` refuses a cached balance for
 * exactly that reason, and the query a counter would save here is a `count(*)`
 * bounded at 500 rows over an index on `user_id` — the cheapest count in the
 * schema.
 *
 * ## Ownership
 *
 * Every method takes `userId` as its FIRST parameter and it is always the
 * session-resolved caller. No method accepts a party, an owner, or a customer
 * id from anywhere else, and no query in this file is missing its `user_id`
 * predicate.
 */
@Injectable()
export class WishlistService {
  private readonly auditLog = new AuditLogger('wishlist');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WishlistSavedItemEntity)
    private readonly items: Repository<WishlistSavedItemEntity>,
    @Inject(WISHLIST_TARGET_PORT) private readonly targets: WishlistTargetPort,
  ) {}

  /**
   * Saves a target, or returns the row that was already there.
   *
   * Idempotent by the UNIQUE index rather than by a branch: `insertOnce` runs
   * `INSERT ... ON CONFLICT DO NOTHING` and reports whether it actually wrote.
   * A caller cannot tell a first save from a repeat — both return the same view
   * — and that is correct, because it is the caller's own list either way.
   *
   * Order of operations, and each step is load-bearing:
   *
   *  1. **Return early if it is already saved.** Not an optimisation: it means a
   *     repeat save of a target that has since been suspended still succeeds
   *     rather than refusing. The customer already holds it; re-sending the same
   *     request must not become a way to discover that the platform has acted
   *     against a professional.
   *  2. **Lock the subject**, so the count below is authoritative.
   *  3. **Check the cap**, inside the lock and inside the transaction.
   *  4. **Check the target is saveable**, through the port, on the caller's
   *     `EntityManager`.
   *  5. **Insert.**
   *
   * Steps 3 and 4 are in that order deliberately. A caller at the cap gets the
   * cap refusal for a target that does not exist, which tells them nothing about
   * the target — the reverse order would let somebody at 500 items probe target
   * existence by comparing two different refusals.
   */
  async save(userId: string, target: WishlistTargetRef): Promise<WishlistItemView> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.getRepository(WishlistSavedItemEntity).findOne({
        where: { userId, targetType: target.targetType, targetId: target.targetId },
      });
      if (existing) {
        // The state is COMPUTED here rather than assumed `available`, and the
        // difference matters: this branch is reached for a target that may have
        // been suspended since it was saved, which is exactly the case the early
        // return exists to let succeed. Answering `available` would be a lie the
        // very next `GET /items` contradicts.
        //
        // It discloses nothing new. The caller already holds this row, and their
        // own list reports the same value for it on every read.
        const available = await this.targets.availableTargets(manager, [target]);
        return toView(existing, stateOf(available, target));
      }

      await this.lockSubject(manager, userId);

      const held = await manager
        .getRepository(WishlistSavedItemEntity)
        .count({ where: { userId } });
      if (held >= WISHLIST_MAX_SAVED_ITEMS) throw new WishlistLimitReachedException();

      // Missing, soft-deleted, suspended, and revoked all arrive here as an
      // ABSENCE from the returned set, and all leave as the platform's single
      // refusal. The port cannot tell this branch which of the four it was, and
      // that is the design rather than a limitation.
      //
      // A single-element batch, deliberately: the same port and therefore the
      // same predicate `list` reads through (ADR-033 §4). A second single-target
      // method would be a second implementation of `V32-DEC-021`.
      const available = await this.targets.availableTargets(manager, [target]);
      if (!available.has(wishlistTargetKey(target))) throw new NotFoundOrNotYoursException();

      const id = uuidv7();
      // `insertOnce` rather than reading `identifiers`: TypeORM echoes back a
      // caller-supplied id whether or not the row was inserted, so the obvious
      // check would report every duplicate as a fresh write. The same trap
      // `LoyaltyLedgerService` documents.
      //
      // Reachable despite the read at the top of this method: two concurrent
      // first-saves of the same target both pass that read. The lock does not
      // help — it is keyed on the subject and both are the same subject, so one
      // waits and then finds the row already present. Either way the index is
      // the guarantee and this branch is the normal outcome, not an error.
      const won = await insertOnce(
        manager
          .createQueryBuilder()
          .insert()
          .into(WishlistSavedItemEntity)
          .values({ id, userId, targetType: target.targetType, targetId: target.targetId }),
      );

      if (!won) {
        const raced = await manager.getRepository(WishlistSavedItemEntity).findOneOrFail({
          where: { userId, targetType: target.targetType, targetId: target.targetId },
        });
        // `available` without a second port call: this transaction proved it
        // moments ago and has not committed since.
        return toView(raced, 'available');
      }

      // Ids and an enum. No target detail, because this module holds none.
      this.auditLog.log({ action: 'wishlist.saved', userId, targetType: target.targetType, targetId: target.targetId });

      const saved = await manager
        .getRepository(WishlistSavedItemEntity)
        .findOneOrFail({ where: { id } });
      return toView(saved, 'available');
    });
  }

  /**
   * Removes a saved target.
   *
   * Always succeeds, and returns nothing a caller could use to tell a real
   * removal from a no-op. That is the mirror image of `save`'s idempotency and
   * it is also an anti-enumeration property: a `DELETE` that reported "there was
   * nothing there" would be a membership oracle for somebody else's list if the
   * `user_id` predicate were ever dropped. Answering identically means the
   * question cannot be asked.
   *
   * A hard delete. There is no `deleted_at` on the table and no archive: the
   * customer asked for it to be gone.
   */
  async remove(userId: string, target: WishlistTargetRef): Promise<void> {
    // `user_id` is in the WHERE clause, not checked afterwards: another
    // customer's saved item is not found for the same reason a nonexistent one
    // is not found.
    await this.items.delete({ userId, targetType: target.targetType, targetId: target.targetId });
    this.auditLog.log({ action: 'wishlist.removed', userId, targetType: target.targetType, targetId: target.targetId });
  }

  /**
   * One page of the caller's own saved items, newest first.
   *
   * Keyset on `(created_at DESC, id DESC)`, which is exactly the index. The
   * `id` tie-break is not decoration: UUIDv7 is time-ordered and
   * `created_at` has microsecond resolution, so two items saved in the same
   * transaction can share an instant — and an ordering that is not total makes a
   * page boundary skip or repeat a row.
   *
   * `limit` is CLAMPED rather than refused. A client asking for 200 gets 50 and
   * a cursor, which is an answer it can act on; a 400 is a dead end for a caller
   * whose only mistake was optimism.
   *
   * ## The target-state projection (Story #9)
   *
   * **The query above is unchanged, and that is the point.** It still reads one
   * table, joins nothing, filters on nothing but `user_id` and the cursor, and
   * orders by the index. A saved row whose target has been deleted or suspended
   * is selected, positioned, and paged exactly as any other — that is the
   * tombstone (`V32-DEC-021`), and it remains a property of what this query does
   * NOT do.
   *
   * The state is then computed for the page in ONE port call, AFTER the rows are
   * chosen. That ordering is what keeps pagination stable while targets change
   * underneath a paging client: because nothing about target state can affect
   * which rows are selected or how they are ordered, a professional suspended
   * between page 1 and page 2 cannot make a row skip, repeat, or move. A
   * projection that filtered instead of annotating would have exactly that bug.
   *
   * **The state is never written anywhere.** It is not cached on the row, not
   * memoised across requests, and not stored in the schema — there is no column
   * that could hold it (ADR-033 §6). A lifted suspension therefore restores the
   * item on the next read with no wishlist write of any kind.
   */
  async list(userId: string, limit: number | undefined, cursor: string | null): Promise<WishlistPageView> {
    const pageSize = clampPageSize(limit);
    const decoded = cursor ? decodeWishlistCursor(cursor) : null;

    const query = this.items
      .createQueryBuilder('w')
      .where('w.user_id = :userId', { userId })
      .orderBy('w.created_at', 'DESC')
      .addOrderBy('w.id', 'DESC')
      // One more than the page, so "is there a next page" is answered by the
      // rows themselves rather than by a second COUNT query that could disagree
      // with the page it describes.
      .take(pageSize + 1);

    if (decoded) {
      // Row-value comparison, not `created_at < :at OR (created_at = :at AND id < :id)`.
      // The tuple form is what the composite index can actually use, and it is
      // one expression rather than two that have to stay in agreement.
      query.andWhere('(w.created_at, w.id) < (:createdAt, :id)', {
        createdAt: decoded.createdAt,
        id: decoded.id,
      });
    }

    const rows = await query.getMany();
    const items = rows.slice(0, pageSize);
    const last = items[items.length - 1];
    const nextCursor = rows.length > pageSize && last ? encodeWishlistCursor(last.createdAt, last.id) : null;

    // ONE call for the whole page, not one per row. The port's contract is a
    // batch for exactly this reason: fifty saved items resolved individually is
    // the N+1 pattern issue #9 forbids by name.
    //
    // `this.dataSource.manager` rather than a transaction: this is a read, and
    // wrapping it would buy a snapshot nothing needs. The rows are already
    // fixed by the time the port runs, so a target changing state mid-request
    // can only change the annotation on a row that is already in the page —
    // never which rows are in it.
    const available = await this.targets.availableTargets(this.dataSource.manager, items.map(refOf));

    return {
      items: items.map((row) => toView(row, stateOf(available, refOf(row)))),
      nextCursor,
    };
  }

  /**
   * Which of `targets` **this** customer has saved.
   *
   * The read behind every saved-state marker on a search result, a professional
   * profile, and a service listing (issue #9). Three properties, and each is
   * load-bearing:
   *
   * **`userId` is the FIRST parameter and is always the session-resolved
   * caller.** Every consumer reaches this through a port bound in the
   * composition root, and every one of those passes `@CurrentUser().userId`.
   * No route anywhere accepts a customer, owner, or user id from a request.
   *
   * **One query, whatever the page size.** The `WHERE` is
   * `user_id = $1 AND ((target_type = 'professional' AND target_id IN (…)) OR
   * (target_type = 'service' AND target_id IN (…)))`, which is two range scans
   * on `uq_wishlist_saved_items_user_target (user_id, target_type, target_id)`
   * inside a single statement. Written type-scoped rather than as a bare
   * `target_id IN (…)` deliberately: without `target_type` the index cannot be
   * seeked past its first column, and the query degrades to a scan of the
   * customer's rows.
   *
   * **It returns membership, never a count.** There is no aggregate here, no
   * "how many customers saved this", and no shape that could carry one —
   * `V32-DEC-021` refuses a popularity signal outright, and the refusal is
   * structural rather than a filter somebody has to remember to apply. The
   * answer is a subset of what the caller asked about, restricted to the
   * caller's own rows, and nothing else exists to leak.
   */
  async savedTargets(userId: string, targets: readonly WishlistTargetRef[]): Promise<ReadonlySet<string>> {
    if (targets.length === 0) return EMPTY_KEYS;

    const idsByType = new Map<WishlistTargetType, string[]>();
    for (const type of WISHLIST_TARGET_TYPES) idsByType.set(type, []);
    for (const target of targets) {
      // De-duplicated implicitly by the database; not worth a Set here, because
      // the page sizes upstream are bounded at fifty.
      idsByType.get(target.targetType)?.push(target.targetId);
    }

    const query = this.items
      .createQueryBuilder('w')
      .select(['w.targetType', 'w.targetId'])
      // The ownership predicate is in the WHERE clause and not checked
      // afterwards, for the reason `remove` records: another customer's saved
      // item is not found for the same reason a nonexistent one is not found.
      .where('w.user_id = :userId', { userId });

    query.andWhere(
      new Brackets((qb) => {
        let any = false;
        for (const [type, ids] of idsByType) {
          if (ids.length === 0) continue;
          // Distinct parameter names per branch: TypeORM's parameter map is
          // flat, so reusing `ids` would silently overwrite the first branch.
          qb.orWhere(`(w.target_type = :type_${type} AND w.target_id IN (:...ids_${type}))`, {
            [`type_${type}`]: type,
            [`ids_${type}`]: ids,
          });
          any = true;
        }
        // Unreachable while the vocabulary is closed and non-empty, and present
        // so that a future third target type nobody wired here cannot turn this
        // into `WHERE user_id = $1` — which would report every saved item as a
        // match for a page it has nothing to do with.
        if (!any) qb.where('1 = 0');
      }),
    );

    const rows = await query.getMany();
    return new Set(rows.map((row) => wishlistTargetKey({ targetType: row.targetType, targetId: row.targetId })));
  }

  /**
   * Every saved item this subject holds, oldest first, for the privacy export.
   *
   * Unpaginated on purpose: the export is a document, not a screen, and the
   * result is bounded at `WISHLIST_MAX_SAVED_ITEMS` by construction.
   *
   * Takes the caller's `EntityManager` so the export is part of ONE consistent
   * snapshot with every other module's — an export assembled from independent
   * reads can contain a saved item that a concurrent request removed halfway
   * through.
   */
  async allForSubject(manager: EntityManager, userId: string): Promise<WishlistSavedItemEntity[]> {
    return manager.getRepository(WishlistSavedItemEntity).find({
      where: { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Serialises adds for one subject, for the length of this transaction.
   *
   * `pg_advisory_xact_lock` rather than `pg_advisory_lock`: the transaction-scoped
   * form is released by COMMIT or ROLLBACK automatically. The session-scoped form
   * would have to be unlocked explicitly, and a path that throws between lock and
   * unlock would leak the lock into a pooled connection where it would outlive
   * the request and block that customer forever.
   *
   * `hashtext` is stable within a major PostgreSQL version and its exact value
   * does not matter — this is a mutex, not an identifier, and a collision between
   * two different customers costs one of them a brief wait and nothing else.
   */
  private async lockSubject(manager: EntityManager, userId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [WISHLIST_LOCK_NAMESPACE, userId]);
  }
}

/** The empty answer, allocated once. */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

/** The saved row, as the port and the contract both address a target. */
function refOf(row: WishlistSavedItemEntity): WishlistTargetRef {
  return { targetType: row.targetType as WishlistTargetType, targetId: row.targetId };
}

/**
 * Set membership, rendered as the contract's two-valued state.
 *
 * The ONE place the mapping happens, so `available` cannot mean one thing in
 * `save` and another in `list`. Note what it cannot express: there is no third
 * branch and no argument that could carry a reason, so a cause has nowhere to
 * enter even by accident.
 */
function stateOf(available: ReadonlySet<string>, target: WishlistTargetRef): WishlistTargetState {
  return available.has(wishlistTargetKey(target)) ? 'available' : 'unavailable';
}

function toView(row: WishlistSavedItemEntity, state: WishlistTargetState): WishlistItemView {
  // Constructed field by field rather than spread. A spread would carry `id` —
  // an internal identifier the contract deliberately does not expose — and would
  // silently carry any column a later migration adds.
  return {
    targetType: row.targetType as WishlistTargetType,
    targetId: row.targetId,
    savedAt: row.createdAt.toISOString(),
    // A literal from the closed vocabulary, computed on this read and stored
    // nowhere. Every unavailable cause arrives here as the same string.
    state,
  };
}

export function clampPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(Math.max(1, Math.floor(limit)), WISHLIST_MAX_PAGE_SIZE);
}

/**
 * The list cursor, opaque on purpose.
 *
 * A readable cursor invites a client to construct one, and a constructed cursor
 * pins the client to this ordering — which then cannot change without breaking
 * them. `chat` records the same reasoning for its inbox cursor.
 */
export function encodeWishlistCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeWishlistCursor(cursor: string): { createdAt: Date; id: string } | null {
  // Bounded before decoding: a caller-supplied string is decoded here, and an
  // unbounded one is a cheap way to make the server allocate.
  if (cursor.length > WISHLIST_MAX_CURSOR_LENGTH) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso);
    // A malformed cursor is treated as ABSENT, not as an error. A client that
    // stored one across a deploy gets page one rather than a 400 it cannot act
    // on, and there is nothing to protect: the caller comes from the session
    // either way, so a forged cursor can only page through their own rows.
    if (!id || !UUID_SHAPE.test(id) || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Shape-checked before the id reaches a query parameter.
 *
 * TypeORM parameterises it, so this is not the injection defence — it is a
 * rejection of garbage that would otherwise reach PostgreSQL as an invalid
 * `uuid` literal and come back as a 500 rather than as page one.
 */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
