import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  COMMERCIAL_CURRENCY,
  CreditPurchaseQuoteViewV1,
  CreditPurchaseViewV1,
  ResolvedPriceQuoteV1,
} from '@beauclick/commercial-policy-contract';

import { PriceResolutionService } from '../catalogue/price-resolution.service';
import {
  AUDIT_TARGET_SUBSCRIPTION,
  SUBSCRIPTION_AUDIT_ACTIONS,
  SUBSCRIPTION_AUDIT_REASONS,
  SYSTEM_ACTOR_LABEL,
} from '../subscription/seller-subscription.audit';
import { CreditPurchaseEntity } from '../subscription/credit-purchase.entity';
import {
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from '../subscription/owned-subscriber-party.port';
import { SellerSubscriptionEntity } from '../subscription/seller-subscription.entities';
import { SellerSubscriptionService } from '../subscription/seller-subscription.service';
import { SubscriptionSellerNotEligibleException } from '../subscription/seller-subscription.exceptions';
import { CreditPurchaseUnavailableException } from './credit-purchase.exceptions';
import { WorkspaceReferenceService } from './workspace-reference';

/** How many purchases one page returns. A protocol bound, not a product rule. */
const PAGE_SIZE = 50;

/**
 * The custom booking-credit purchase surface — V3.3 #57 (`#40c-1`), ADR-047.
 *
 * ## What it does, in one sentence
 *
 * Prices a quantity against the schedule the seller's subscription was bound to
 * by an administrator, and records what they were offered so immutably that a
 * later price change cannot rewrite it.
 *
 * ## What it does NOT do, and cannot
 *
 * **It writes no booking-credit grant.** There is no repository, query or
 * import here that could: `BookingCreditGrantEntity` is not referenced in this
 * file and `ck_booking_credit_grants_source` still admits only `plan_included`.
 * A purchase becomes credit in #99, in the same transaction that records an
 * adapter-verified payment fact, and not before (`V33-DEC-026` R3).
 *
 * It also creates no order, no payment intent, no ledger entry and no event,
 * and calls no provider.
 *
 * ## Every refusal is the same refusal
 *
 * A null binding, a missing schedule, a wrong-purpose schedule, no active
 * published version, incomplete tiers, an out-of-bounds quantity and a
 * concurrent catalogue change all leave by ONE throw with ONE body
 * (`V33-DEC-026` R8, `V33-DEC-027` R6). A caller cannot tell them apart, so the
 * administrator's catalogue cannot be enumerated through error messages.
 *
 * Ownership refusals are deliberately NOT folded into that: they keep #69's
 * `SUBSCRIPTION_SELLER_NOT_ELIGIBLE`, so malformed, foreign, stale and
 * nonexistent references stay byte-identical to each other, which is the
 * property `V33-DEC-019` required and this story must not weaken.
 *
 * ## Nothing here logs
 *
 * Same requirement as the subscription surface: a `workspaceRef` in a log line
 * would be a per-seller high-cardinality identifier attached to everything
 * else in the record.
 */
@Injectable()
export class CreditPurchaseService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly prices: PriceResolutionService,
    private readonly subscriptions: SellerSubscriptionService,
    private readonly references: WorkspaceReferenceService,
    private readonly audit: AdminAuditService,
    @Inject(OWNED_SUBSCRIBER_PARTY_RESOLVER)
    private readonly parties: OwnedSubscriberPartyResolver,
  ) {}

  /**
   * `POST /me/subscriptions/:workspaceRef/credit-purchases/quote`.
   *
   * Read-only. A POST because a quantity belongs in a body, not because
   * anything is written — nothing is, not even an audit row.
   *
   * It runs in a transaction anyway, so the schedule it reads is the schedule
   * that would price a purchase submitted in the same breath.
   */
  async quote(userId: string, workspaceRef: string, quantity: number): Promise<CreditPurchaseQuoteViewV1> {
    return this.dataSource.transaction(async (manager) => {
      const { subscription } = await this.resolveWorkspace(manager, userId, workspaceRef);
      const priced = await this.priceFor(manager, subscription, quantity, new Date());
      return {
        quantity: priced.quantity,
        unitPriceToman: priced.unitPriceToman,
        totalToman: priced.totalToman,
        currency: COMMERCIAL_CURRENCY,
      };
    });
  }

  /**
   * `POST /me/subscriptions/:workspaceRef/credit-purchases`.
   *
   * One transaction: resolve the owned workspace, read its snapshotted schedule
   * key, resolve the version active at ONE captured instant, insert the whole
   * snapshot in one statement, and write the audit row beside it.
   *
   * ## Idempotency is the database's, not this method's
   *
   * The read below is the common-path shortcut. `uq_credit_purchases_request`
   * is the guarantee: N concurrent submissions of one key all pass the read,
   * all insert, and exactly one survives. The loser re-reads the winner's row
   * and both callers receive the same body — so a replay writes no second row
   * and no second audit entry.
   *
   * ## Why the price is resolved on the caller's manager
   *
   * So the version that priced the row and the row itself are read and written
   * on one connection in one transaction. Resolving on a separate connection
   * would let an administrator publish a new version between the two, giving a
   * purchase a price it was never offered — and no constraint could catch it,
   * because both rows would be individually valid (ADR-047 §4).
   */
  async create(
    userId: string,
    workspaceRef: string,
    quantity: number,
    requestKey: string,
  ): Promise<CreditPurchaseViewV1> {
    return this.dataSource.transaction(async (manager) => {
      const { subscription } = await this.resolveWorkspace(manager, userId, workspaceRef);

      const repository = manager.getRepository(CreditPurchaseEntity);
      const existing = await repository.findOne({
        where: { subscriptionId: subscription.id, requestKey },
      });
      if (existing) return this.toView(existing);

      // ONE instant, used for the resolution and stored on the row, so the
      // snapshot can say exactly when the price it recorded was live.
      const effectiveAt = new Date();
      const priced = await this.priceFor(manager, subscription, quantity, effectiveAt);

      const id = uuidv7();
      const row = repository.create({
        id,
        subscriptionId: subscription.id,
        // Copied from the subscription, never re-resolved from live
        // affiliation. `fk_credit_purchases_subscription_party` makes the copy
        // provably faithful.
        subscriberPartyType: subscription.subscriberPartyType,
        subscriberPartyId: subscription.subscriberPartyId,
        quantity: priced.quantity,
        scheduleKey: priced.scheduleKey,
        priceScheduleVersionId: priced.scheduleVersionId,
        priceTierId: priced.tierId,
        unitPriceToman: priced.unitPriceToman,
        totalToman: priced.totalToman,
        currencyCode: COMMERCIAL_CURRENCY,
        effectiveAt,
        lifecycleState: 'awaiting_payment',
        requestKey,
        requestedByUserId: userId,
      });

      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(CreditPurchaseEntity)
        .values(row)
        .orIgnore()
        .returning('id')
        .execute();

      if ((inserted.identifiers?.length ?? 0) === 0) {
        // The unique constraint declined it: a concurrent submission of the
        // same key won. Re-read the winner and return it byte-for-byte. No
        // audit row, because nothing was written here.
        const winner = await repository.findOne({
          where: { subscriptionId: subscription.id, requestKey },
        });
        if (!winner) throw new CreditPurchaseUnavailableException();
        return this.toView(winner);
      }

      /*
       * The audit row, in the SAME transaction as the insert.
       *
       * `AdminAuditService.recordSystem` and not `AuditLogger`: a log line
       * survives a ROLLBACK and would record a purchase that never happened.
       * That correction is `#58a`'s, and it applies identically here.
       *
       * No `requestKey` and no counterparty in the record — the row already
       * holds them, and an audit trail is identifiers, enums and counts.
       */
      await this.audit.recordSystem(manager, {
        actorLabel: SYSTEM_ACTOR_LABEL,
        action: SUBSCRIPTION_AUDIT_ACTIONS.creditPurchaseRequested,
        targetType: AUDIT_TARGET_SUBSCRIPTION,
        targetId: subscription.id,
        after: {
          purchaseId: id,
          quantity: priced.quantity,
          unitPriceToman: priced.unitPriceToman,
          totalToman: priced.totalToman,
          currencyCode: COMMERCIAL_CURRENCY,
          scheduleKey: priced.scheduleKey,
          priceScheduleVersionId: priced.scheduleVersionId,
          lifecycleState: 'awaiting_payment',
        },
        reason: SUBSCRIPTION_AUDIT_REASONS.creditPurchaseRequested,
      });

      const written = await repository.findOneOrFail({ where: { id } });
      return this.toView(written);
    });
  }

  /**
   * `GET /me/subscriptions/:workspaceRef/credit-purchases`.
   *
   * Newest first, keyset-paged by `(created_at, id)` — both descending, and
   * both in the index, so the page cost does not grow with the seller's
   * history.
   *
   * ## The cursor cannot cross a workspace
   *
   * The query is keyed by `subscription_id`, and that subscription came from
   * matching the reference against what this caller owns. A cursor stolen from
   * another workspace selects rows within THIS subscription or none at all; it
   * cannot widen the set.
   */
  async list(userId: string, workspaceRef: string, cursor?: string): Promise<CreditPurchaseViewV1[]> {
    const manager = this.dataSource.manager;
    const { subscription } = await this.resolveWorkspace(manager, userId, workspaceRef);

    const query = manager
      .getRepository(CreditPurchaseEntity)
      .createQueryBuilder('p')
      .where('p.subscription_id = :subscriptionId', { subscriptionId: subscription.id })
      .orderBy('p.created_at', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .limit(PAGE_SIZE);

    const after = decodeCursor(cursor);
    if (after) {
      query.andWhere('(p.created_at, p.id) < (:createdAt, :id)', after);
    }

    const rows = await query.getMany();
    return rows.map((row) => this.toView(row));
  }

  // ========================================================================
  // Internals
  // ========================================================================

  /**
   * The owned workspace and its ACTIVE subscription.
   *
   * Ownership is re-evaluated on every request through the same resolver the
   * subscription surface uses, so staff affiliation never becomes authority
   * (`V33-DEC-020`, restated by `V33-DEC-026` R6).
   *
   * A caller who owns a party but has no active subscription is not eligible
   * rather than unavailable: they have no workspace to buy for, which is an
   * ownership fact and not a catalogue one.
   */
  private async resolveWorkspace(
    manager: EntityManager,
    userId: string,
    workspaceRef: string,
  ): Promise<{ party: OwnedSubscriberParty; subscription: SellerSubscriptionEntity }> {
    const parties = await this.parties.ownedPartiesFor(manager, userId);
    if (parties.length === 0) throw new SubscriptionSellerNotEligibleException();

    const party = this.references.resolve(userId, parties, workspaceRef);
    const subscription = await this.subscriptions.findActive(party, manager);
    if (!subscription) throw new SubscriptionSellerNotEligibleException();

    return { party, subscription };
  }

  /**
   * The price for a quantity, or the one public refusal.
   *
   * Reads ONLY the subscription's snapshotted schedule key. A null key means
   * this seller's plan version offers no custom credits — which is every plan
   * version that exists today, because `V33-DEC-027` R8 backfills nothing — and
   * that is a refusal, never a fallback to some other schedule.
   *
   * Every catalogue-side failure is caught and collapsed here, which is the one
   * place the collapse happens.
   */
  private async priceFor(
    manager: EntityManager,
    subscription: SellerSubscriptionEntity,
    quantity: number,
    at: Date,
  ): Promise<ResolvedPriceQuoteV1> {
    const scheduleKey = subscription.snapshotBookingCreditScheduleKey;
    if (scheduleKey === null) throw new CreditPurchaseUnavailableException();

    try {
      return await this.prices.resolveBookingCreditWithin(manager, scheduleKey, at, quantity);
    } catch {
      // Deliberately unconditional. Distinguishing "unconfigured" from
      // "incomplete" from "out of bounds" would hand a caller a catalogue
      // oracle one refusal at a time.
      throw new CreditPurchaseUnavailableException();
    }
  }

  private toView(row: CreditPurchaseEntity): CreditPurchaseViewV1 {
    return {
      purchaseId: row.id,
      quantity: row.quantity,
      unitPriceToman: row.unitPriceToman,
      totalToman: row.totalToman,
      currency: COMMERCIAL_CURRENCY,
      state: row.lifecycleState,
      effectiveAt: row.effectiveAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * `<iso-instant>|<uuid>`, base64url.
 *
 * Opaque so a client treats it as a token rather than as a filter it can edit
 * into something else, and unsigned because it selects nothing a signature
 * would protect: the workspace is decided before the cursor is read.
 */
function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const parsed = new Date(createdAt);
    if (Number.isNaN(parsed.getTime()) || !id) return null;
    return { createdAt: parsed, id };
  } catch {
    // A malformed cursor is the first page, not an error: it names no rows a
    // caller could not already see, and a 400 here would be one more way to
    // probe the surface.
    return null;
  }
}

/** The token for a row, so a caller can ask for the next page. */
export function encodeCreditPurchaseCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}
