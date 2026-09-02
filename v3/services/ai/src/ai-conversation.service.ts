import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, LessThan } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import {
  AI_INACTIVITY_CLOSE_HOURS,
  AI_MAX_PAGE_SIZE,
  AI_MAX_RETAINED_CONVERSATIONS,
  AI_RETENTION_DAYS,
} from '@beauclick/ai-contract';
import { logOperation } from '@beauclick/events';

import { AI_CLOCK, AiClock, hoursBetween } from './ai-clock';
import { AiConversationLimitException, AiConversationNotFoundException } from './ai.exceptions';
import { AiConversationEntity, AiMessageEntity, AiRecommendationEntity } from './entities/ai.entities';

/**
 * The bounded-session lifecycle (`V32-DEC-002`, `V32-DEC-003`, `V32-DEC-007`).
 *
 * Four rules, and each one is here because leaving it to a sweep somebody has
 * to remember is how `GAP-12` happened:
 *
 * 1. **Inactivity closure at 24 hours.** Logical, and applied on read as well as
 *    by the sweep — see `closeIfStale`.
 * 2. **A closed conversation is never reopened.** Continuing produces a new one.
 * 3. **At most 20 retained conversations per customer**, with eviction taking
 *    the OLDEST CLOSED one and refusing rather than touching an active one.
 * 4. **30-day retention**, destroying rows rather than flagging them.
 *
 * ## Why closure is applied on read and not only by a sweep
 *
 * A background sweep is the mechanism, and it runs. But a sweep is also a thing
 * that can be disabled (`DISABLE_BACKGROUND_SWEEPS` exists and every test suite
 * sets it), can fall behind, and can be down for the twenty minutes that matter.
 * If closure existed ONLY in the sweep, then during any of those windows a
 * three-day-old conversation would still accept messages — and the 24-hour
 * bound would be a claim about the sweep's uptime rather than about the product.
 *
 * So the rule is evaluated wherever it matters, from the same injected clock,
 * and the sweep is an optimisation that keeps the table tidy rather than the
 * thing the guarantee rests on. `closeIfStale` is idempotent and cheap.
 */
@Injectable()
export class AiConversationService {
  private readonly logger = new Logger('AiConversationService');

  constructor(
    private readonly dataSource: DataSource,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    private readonly config: ConfigService,
  ) {}

  private get inactivityHours(): number {
    const configured = Number(this.config.get<string>('AI_INACTIVITY_CLOSE_HOURS'));
    return Number.isFinite(configured) && configured > 0 ? configured : AI_INACTIVITY_CLOSE_HOURS;
  }

  private get retentionDays(): number {
    const configured = Number(this.config.get<string>('AI_RETENTION_DAYS'));
    return Number.isFinite(configured) && configured > 0 ? configured : AI_RETENTION_DAYS;
  }

  private get retainedCap(): number {
    const configured = Number(this.config.get<string>('AI_MAX_RETAINED_CONVERSATIONS'));
    return Number.isInteger(configured) && configured > 0 ? configured : AI_MAX_RETAINED_CONVERSATIONS;
  }

  /**
   * Creates a conversation, making room first if the cap requires it.
   *
   * The whole operation is one transaction, and the ordering inside it is the
   * decision:
   *
   *   1. close anything that has aged out — so a stale ACTIVE conversation
   *      becomes an evictable CLOSED one before the cap is measured, rather than
   *      counting against a customer as though it were live;
   *   2. count;
   *   3. if at the cap, destroy the OLDEST CLOSED conversation — one, not as
   *      many as needed, because the cap can only be exceeded by one at a time;
   *   4. if there is no closed conversation to destroy, REFUSE.
   *
   * Step 4 is `V32-DEC-002`'s "an active session is never silently evicted", and
   * it is the reason eviction is not simply `ORDER BY last_activity_at LIMIT 1`.
   * A customer with twenty open threads gets a refusal telling them to delete
   * one; they do not get their oldest live conversation destroyed underneath
   * them to make room for a new one they can always start later.
   *
   * `SELECT ... FOR UPDATE` on the customer's rows, so two concurrent creates
   * cannot both see nineteen and both insert.
   */
  async create(userId: string): Promise<AiConversationEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.closeStaleFor(manager, userId);

      // Locks this customer's conversation rows for the duration. Scoped to one
      // user, so it contends with nothing except that user's own concurrent
      // request -- which is exactly the race being closed.
      const owned: Array<{ id: string; status: string; closed_at: Date | null }> = await manager.query(
        `SELECT id, status, closed_at FROM ai.conversations WHERE user_id = $1 ORDER BY created_at ASC FOR UPDATE`,
        [userId],
      );

      const cap = this.retainedCap;
      if (owned.length >= cap) {
        const oldestClosed = owned
          .filter((row) => row.status === 'closed')
          .sort((a, b) => (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0))[0];

        if (!oldestClosed) throw new AiConversationLimitException(cap);

        // CASCADE destroys the messages and recommendations in the same
        // statement. `V32-DEC-003` requires destruction rather than a flag, and
        // a cascade is what makes it atomic with the parent's removal instead of
        // a second statement that can fail alone.
        await manager.query(`DELETE FROM ai.conversations WHERE id = $1 AND user_id = $2`, [oldestClosed.id, userId]);
        logOperation(this.logger, 'ai.conversation.evicted', { reason: 'retained_cap', cap });
      }

      const now = this.clock.now();
      const conversation = manager.getRepository(AiConversationEntity).create({
        id: uuidv7(),
        userId,
        status: 'active',
        closureReason: null,
        messageCount: 0,
        lastActivityAt: now,
        closedAt: null,
      });
      return manager.getRepository(AiConversationEntity).save(conversation);
    });
  }

  /**
   * One owned conversation, with the inactivity rule already applied.
   *
   * A conversation belonging to somebody else and one that does not exist both
   * produce `AiConversationNotFoundException` — the owner is in the WHERE
   * clause, so the two cases are indistinguishable by construction rather than
   * by remembering to make them so.
   */
  async requireOwned(manager: EntityManager, userId: string, conversationId: string): Promise<AiConversationEntity> {
    const conversation = await manager
      .getRepository(AiConversationEntity)
      .findOne({ where: { id: conversationId, userId } });
    if (!conversation) throw new AiConversationNotFoundException();
    return this.closeIfStale(manager, conversation);
  }

  /**
   * The same check, on this service's own connection.
   *
   * `requireOwned` takes an `EntityManager` because the message path calls it
   * inside the transaction that also reserves the quota — reading ownership on a
   * separate connection there would open a window between the check and the
   * write. A plain read has no such window, so it gets its own entry point
   * rather than making every caller reach for a manager it does not need.
   */
  async readOwned(userId: string, conversationId: string): Promise<AiConversationEntity> {
    return this.requireOwned(this.dataSource.manager, userId, conversationId);
  }

  /**
   * Applies the inactivity rule to one conversation.
   *
   * Idempotent, and safe to call on an already-closed row. Returns the
   * conversation as it now stands, so a caller never has to decide whether to
   * re-read.
   */
  async closeIfStale(manager: EntityManager, conversation: AiConversationEntity): Promise<AiConversationEntity> {
    if (conversation.status !== 'active') return conversation;
    const now = this.clock.now();
    if (hoursBetween(conversation.lastActivityAt, now) < this.inactivityHours) return conversation;

    await manager.query(
      `UPDATE ai.conversations SET status = 'closed', closure_reason = 'inactivity', closed_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'active'`,
      [conversation.id, now],
    );
    conversation.status = 'closed';
    conversation.closureReason = 'inactivity';
    conversation.closedAt = now;
    return conversation;
  }

  /** The same rule, applied to every one of a customer's active conversations. */
  private async closeStaleFor(manager: EntityManager, userId: string): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.inactivityHours * 3_600_000);
    const result = await manager.query(
      `UPDATE ai.conversations SET status = 'closed', closure_reason = 'inactivity', closed_at = $3, updated_at = $3
       WHERE user_id = $1 AND status = 'active' AND last_activity_at < $2`,
      [userId, cutoff, now],
    );
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
  }

  /**
   * Cursor pagination over a customer's conversations.
   *
   * A keyset cursor rather than an offset, for the reason keyset pagination
   * always wins on a mutable list: a conversation destroyed by the retention
   * sweep between page one and page two shifts every subsequent offset by one,
   * so an offset-paginated reader silently SKIPS a row. The cursor is
   * `(last_activity_at, id)` — the id breaks ties, so the ordering is total and
   * two conversations touched in the same transaction cannot swap places
   * between requests.
   *
   * Opaque to the client: base64 of the two values, so nobody starts
   * constructing one by hand and depending on the shape.
   */
  async list(
    userId: string,
    limit: number,
    cursor: string | null,
  ): Promise<{ items: AiConversationEntity[]; nextCursor: string | null }> {
    const pageSize = Math.min(Math.max(1, limit), AI_MAX_PAGE_SIZE);
    const decoded = cursor ? decodeCursor(cursor) : null;

    const repo = this.dataSource.getRepository(AiConversationEntity);
    const query = repo
      .createQueryBuilder('c')
      .where('c.userId = :userId', { userId })
      .orderBy('c.lastActivityAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      // One extra row, to learn whether a next page exists without a COUNT.
      .take(pageSize + 1);

    if (decoded) {
      query.andWhere('(c.lastActivityAt, c.id) < (:activityAt, :id)', {
        activityAt: decoded.activityAt,
        id: decoded.id,
      });
    }

    const rows = await query.getMany();
    const items = rows.slice(0, pageSize);

    // The inactivity rule, applied to what is being shown. A list that renders a
    // three-day-old conversation as `active` would be lying to the customer
    // about whether they can still write in it.
    for (const item of items) await this.closeIfStale(this.dataSource.manager, item);

    const nextCursor =
      rows.length > pageSize && items.length > 0
        ? encodeCursor(items[items.length - 1].lastActivityAt, items[items.length - 1].id)
        : null;

    return { items, nextCursor };
  }

  /** One owned conversation's messages, in deterministic order, with their recommendations. */
  async messagesOf(
    userId: string,
    conversationId: string,
  ): Promise<{ messages: AiMessageEntity[]; recommendations: AiRecommendationEntity[] }> {
    const messages = await this.dataSource.getRepository(AiMessageEntity).find({
      // `userId` as well as `conversationId`, even though the composite foreign
      // key makes a mismatch unwritable. Defence in depth costs one indexed
      // predicate, and the day somebody drops the constraint in a migration this
      // query is still correct.
      where: { conversationId, userId },
      order: { sequence: 'ASC' },
    });
    if (messages.length === 0) return { messages: [], recommendations: [] };

    const recommendations = await this.dataSource.getRepository(AiRecommendationEntity).find({
      where: { conversationId, userId },
      order: { position: 'ASC' },
    });
    return { messages, recommendations };
  }

  /**
   * Permanent, immediate destruction of one owned conversation (`V32-DEC-003`).
   *
   * Idempotent: deleting a conversation that is already gone is a success, not a
   * 404. A client retrying a delete it never saw the response to must not be
   * told the resource is missing — that reads as "somebody else deleted it" when
   * the truth is "you did".
   *
   * A conversation belonging to somebody else is likewise a silent success, and
   * that is deliberate rather than sloppy: the alternative — 404 for a foreign
   * id, 204 for one's own — is a membership oracle. Nothing is destroyed,
   * because `user_id` is in the WHERE clause.
   */
  async destroy(userId: string, conversationId: string): Promise<boolean> {
    const result = await this.dataSource.query(`DELETE FROM ai.conversations WHERE id = $1 AND user_id = $2`, [
      conversationId,
      userId,
    ]);
    const deleted = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (deleted > 0) logOperation(this.logger, 'ai.conversation.deleted', { byUser: true });
    return deleted > 0;
  }

  // -------------------------------------------------------------------------
  // Sweeps
  // -------------------------------------------------------------------------

  /**
   * Closes every conversation past the inactivity horizon, platform-wide.
   *
   * Idempotent and safe to run at any interval. Not what the 24-hour guarantee
   * rests on — see this class's header — but it is what keeps the table's
   * `status` column true for anybody reading it directly, including the
   * retention sweep below, which measures age from `closed_at`.
   */
  async sweepInactive(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.inactivityHours * 3_600_000);
    const result = await this.dataSource.query(
      `UPDATE ai.conversations SET status = 'closed', closure_reason = 'inactivity', closed_at = $2, updated_at = $2
       WHERE status = 'active' AND last_activity_at < $1`,
      [cutoff, now],
    );
    const closed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (closed > 0) logOperation(this.logger, 'ai.sweep.inactivity', { closed });
    return closed;
  }

  /**
   * Destroys conversations past the 30-day retention boundary (`V32-DEC-007`).
   *
   * Age is measured from `last_activity_at`, NOT from `closed_at`, and the
   * difference matters: a conversation that closed on day 2 through inactivity
   * and one that closed on day 29 because the sweep was down should be destroyed
   * at the same time, because the customer's last interaction with both was at
   * the same age. Measuring from `closed_at` would make the retention period
   * depend on when a background job happened to run.
   *
   * Rows are DELETED. `V32-DEC-003` and `V32-DEC-007` both refuse a soft delete
   * that would leave the prose in the table while the privacy claim said
   * otherwise, and CASCADE destroys the messages and recommendations with it.
   */
  async sweepRetention(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionDays * 86_400_000);
    const result = await this.dataSource.query(`DELETE FROM ai.conversations WHERE last_activity_at < $1`, [cutoff]);
    const destroyed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (destroyed > 0) logOperation(this.logger, 'ai.sweep.retention', { destroyed, retentionDays: this.retentionDays });
    return destroyed;
  }

  /** Exposed for the sweep scheduler's log line and for the readiness surface's counts. */
  async countStaleActive(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.inactivityHours * 3_600_000);
    return this.dataSource
      .getRepository(AiConversationEntity)
      .count({ where: { status: 'active', lastActivityAt: LessThan(cutoff) } });
  }
}

/**
 * The cursor, opaque on purpose.
 *
 * Base64 of `activityAtIso|id`. Opaque rather than a plain timestamp because a
 * readable cursor invites a client to construct one, and a constructed cursor is
 * a client that has pinned itself to this ordering — which then cannot change
 * without breaking them.
 */
function encodeCursor(activityAt: Date, id: string): string {
  return Buffer.from(`${activityAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { activityAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const activityAt = new Date(iso);
    // A malformed cursor is treated as ABSENT, not as an error. A client that
    // stored one across a deploy, or truncated it in a URL, should get page one
    // rather than a 400 it cannot act on -- and there is nothing to protect,
    // because the owner comes from the session either way.
    if (!id || Number.isNaN(activityAt.getTime())) return null;
    return { activityAt, id };
  } catch {
    return null;
  }
}
