import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';

import { CommercialPlanVersionEntity, CommercialPriceScheduleVersionEntity, CommercialPriceTierEntity } from '../catalogue/commercial-catalogue.entities';
import { BookingCreditGrantService } from './booking-credit-grant.service';
import { BookingCreditGrantEntity, SellerSubscriptionEntity } from './seller-subscription.entities';
import {
  AUDIT_TARGET_SUBSCRIPTION,
  SUBSCRIPTION_AUDIT_ACTIONS,
  SUBSCRIPTION_AUDIT_REASONS,
  SYSTEM_ACTOR_LABEL,
} from './seller-subscription.audit';
import {
  SubscriptionChangedConcurrentlyException,
  SubscriptionNotConfiguredException,
  SubscriptionPaidActivationUnavailableException,
  SubscriptionPlanNotSelectableException,
  SubscriptionSellerNotEligibleException,
} from './seller-subscription.exceptions';
import {
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from './owned-subscriber-party.port';

/**
 * The subscription lifecycle (ADR-042, `V33-DEC-018`, Story #56 / `#56a`).
 *
 * ## What this class is for
 *
 * Making "what is this seller entitled to?" a question with a ROW as its
 * answer. ADR-041 built the catalogue of what MAY be sold and stopped exactly
 * here; until a seller holds a row, every later story would have to invent an
 * entitlement, and the invented answer is always a constant `V33-DEC-009`
 * forbids.
 *
 * ## There is no controller in this story
 *
 * Story #56a ships no HTTP route — that is #69. Every method here is an
 * internal domain operation, and the two that #69 will drive
 * (`selectPlanVersion`, `cancel`) are complete and tested now so that story is
 * a route layer rather than a second implementation.
 *
 * ## Three guarantees this class does NOT provide
 *
 * Stated because reading the code would otherwise suggest it does:
 *
 *  1. **One active subscription per party** is
 *     `uq_seller_subscriptions_one_active_per_party`. The reads below are for
 *     readable outcomes; the index is the protection. Check-then-insert cannot
 *     survive a race at read committed and this never relies on it.
 *  2. **Zero-price only** is `ck_seller_subscriptions_zero_price`. The refusal
 *     raised here arrives first and says something useful, but the constraint
 *     is what makes a paid subscription unwritable.
 *  3. **Snapshot and party immutability** is
 *     `tg_seller_subscriptions_immutable`. Nothing here updates those columns,
 *     and nothing could.
 *
 * A guarantee upheld by this class is upheld by whoever remembers to come
 * through this class.
 */
@Injectable()
export class SellerSubscriptionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    private readonly grants: BookingCreditGrantService,
    @Inject(OWNED_SUBSCRIBER_PARTY_RESOLVER)
    private readonly parties: OwnedSubscriberPartyResolver,
  ) {}

  // ---------------------------------------------------------------- reads

  /** Every party this user owns. Empty for a caller who owns none — never a fabricated party. */
  async ownedPartiesFor(userId: string): Promise<OwnedSubscriberParty[]> {
    return this.dataSource.transaction((manager) => this.parties.ownedPartiesFor(manager, userId));
  }

  /**
   * The party's active subscription, or null.
   *
   * Keyed by PARTY, never by user: nothing in this domain holds "the user's
   * subscription", which is why a cross-party read is unrepresentable rather
   * than merely refused (ADR-042 §3).
   */
  async findActive(party: OwnedSubscriberParty, manager?: EntityManager): Promise<SellerSubscriptionEntity | null> {
    const runner = manager ?? this.dataSource.manager;
    return runner.getRepository(SellerSubscriptionEntity).findOne({
      where: {
        subscriberPartyType: party.partyType,
        subscriberPartyId: party.partyId,
        lifecycleState: 'active',
      },
    });
  }

  /** The party's whole immutable chain, newest first. */
  async historyFor(party: OwnedSubscriberParty): Promise<SellerSubscriptionEntity[]> {
    return this.dataSource.getRepository(SellerSubscriptionEntity).find({
      where: { subscriberPartyType: party.partyType, subscriberPartyId: party.partyId },
      order: { effectiveAt: 'DESC', createdAt: 'DESC' },
    });
  }

  /** Everything granted to a party. #58 will derive a balance from these and its own consumption rows. */
  async grantsFor(party: OwnedSubscriberParty): Promise<BookingCreditGrantEntity[]> {
    return this.dataSource.getRepository(BookingCreditGrantEntity).find({
      where: { subscriberPartyType: party.partyType, subscriberPartyId: party.partyId },
      order: { grantedAt: 'DESC' },
    });
  }

  // --------------------------------------------------------------- writes

  /**
   * THE LAZY-ENSURE PATH (`V33-DEC-018`, ADR-042 §4).
   *
   * Gives a party the base workspace if it has no active subscription, and does
   * nothing if it has. Safe to call on every commercial access, from any number
   * of concurrent requests.
   *
   * ## Why the unique violation is caught rather than prevented
   *
   * Two concurrent first accesses both read no subscription and both insert.
   * The partial unique index refuses one, and that refusal is the CORRECT
   * outcome rather than an error to report: the caller wanted the party to have
   * a subscription, and it does. So the loser re-reads and returns the winner's
   * row, and the caller cannot tell which it was.
   *
   * Doing it the other way round — locking the party first — would need a lock
   * on a row in another schema this module must not write to, or an advisory
   * lock whose scope lives in application code. The index expresses the same
   * guarantee where a future query cannot forget it.
   */
  async ensureBaseSubscription(party: OwnedSubscriberParty): Promise<SellerSubscriptionEntity> {
    return this.dataSource.transaction(async (manager) => this.ensureBaseSubscriptionWithin(manager, party));
  }

  /** The same, inside a caller's transaction. Used by `cancel`, which must restore the base workspace atomically. */
  async ensureBaseSubscriptionWithin(
    manager: EntityManager,
    party: OwnedSubscriberParty,
  ): Promise<SellerSubscriptionEntity> {
    const existing = await this.findActive(party, manager);
    if (existing) return existing;

    if (!(await this.parties.isEligible(manager, party))) {
      throw new SubscriptionSellerNotEligibleException();
    }

    const version = await this.requireAutoAssignableVersion(manager);

    const created = await this.activate(manager, {
      party,
      version,
      action: SUBSCRIPTION_AUDIT_ACTIONS.assigned,
      reason: SUBSCRIPTION_AUDIT_REASONS.baseWorkspaceAssigned,
      actorUserId: null,
      onConflict: 'ignore',
    });

    if (created) return created;

    /*
     * Lost the race, and the caller got what it asked for anyway.
     *
     * `ON CONFLICT DO NOTHING` rather than catching a unique violation, and the
     * difference is not stylistic: in PostgreSQL a failed statement aborts the
     * whole transaction, so a caught violation could not then re-read inside the
     * same transaction without a savepoint. Letting the database decline the
     * insert leaves the transaction healthy, which matters because `cancel`
     * calls this INSIDE its own transaction.
     */
    const winner = await this.findActive(party, manager);
    if (!winner) {
      throw new SubscriptionNotConfiguredException(
        'the base workspace could not be assigned and no active subscription exists for this party',
      );
    }
    return winner;
  }

  /**
   * Move a party onto a different published plan version.
   *
   * Upgrade and downgrade are the same operation and neither is a state
   * transition: the active row is superseded and a NEW row is inserted with its
   * own snapshot, in one transaction. History is immutable for free, because
   * nothing was edited.
   *
   * Grants already issued are untouched (`V33-DEC-018`, `V33-DEC-010`).
   *
   * #69 drives this. It is implemented and tested here so that story adds a
   * route rather than a second lifecycle.
   */
  async selectPlanVersion(
    party: OwnedSubscriberParty,
    planKey: string,
    version: number,
    actorUserId: string,
  ): Promise<SellerSubscriptionEntity> {
    return (await this.applyPlanSelection(party, planKey, version, actorUserId)).subscription;
  }

  /**
   * The same operation, reporting WHICH outcome occurred.
   *
   * Story #69 needs to tell a seller that their selection was already applied
   * (`selection_already_applied`), and `selectPlanVersion` above cannot say so
   * — it returns the active row either way, which is the right domain contract
   * and an ambiguous one for a route. Rather than duplicate the transaction,
   * `selectPlanVersion` delegates here and discards the discriminator, so
   * `#56a`'s contract is unchanged and there is exactly one implementation.
   *
   * The refusal itself is raised by the ROUTE, not here. A domain method that
   * threw on a replay would make `selectPlanVersion`'s documented "returns the
   * active row" impossible to honour, and #56a's suite asserts that behaviour
   * directly.
   *
   * ## The `#56a` first-selection race, repaired here
   *
   * `V33-DEC-019` records the defect: this method used to read `current`, find
   * NOTHING when the party had no subscription yet, skip the supersede
   * entirely, and insert an active row with `onConflict: 'throw'`. Two
   * concurrent first selections therefore both inserted, and
   * `uq_seller_subscriptions_one_active_per_party` refused one — as a raw
   * `QueryFailedError`, which reached the client as an untranslated 500.
   *
   * The fix is the `ensureBaseSubscriptionWithin` call below, and it is a fix
   * rather than a retry loop because of WHERE it sits: inside this
   * transaction, before the read. Afterwards `current` is never null, so the
   * compare-and-swap in `transition` always runs, and the loser of a race gets
   * `affected === 0` and the translated `SUBSCRIPTION_CHANGED_CONCURRENTLY`
   * that every other concurrent change already produced.
   *
   * No schema change was needed and none is authorized: the existing partial
   * unique index is what serialises the two ensures, and the existing
   * compare-and-swap is what serialises the two selections. The defect was that
   * one code path walked past both.
   */
  async applyPlanSelection(
    party: OwnedSubscriberParty,
    planKey: string,
    version: number,
    actorUserId: string,
  ): Promise<{ outcome: 'selected' | 'already_applied'; subscription: SellerSubscriptionEntity }> {
    return this.dataSource.transaction(async (manager) => {
      // Eligibility BEFORE the plan lookup (`V33-DEC-019`). An ineligible
      // caller must not be able to probe which plan versions exist by comparing
      // which refusal comes back.
      if (!(await this.parties.isEligible(manager, party))) {
        throw new SubscriptionSellerNotEligibleException();
      }

      /*
       * Read BEFORE the ensure, and that ordering is what makes the two
       * outcomes below distinguishable.
       *
       * `already_applied` must mean "you already held these terms and nothing
       * was written". A seller who holds NOTHING and selects the base plan
       * version is a different case with the same end state: the ensure just
       * delivered exactly what they asked for, so that is a real selection with
       * a real audit row, and reporting it as a replay would be a lie about
       * what the request did.
       */
      const existing = await this.findActive(party, manager);

      /*
       * The race repair, and the source of `current`.
       *
       * `ensureBaseSubscriptionWithin` RETURNS the party's active subscription
       * either way — the one that was already there, or the base workspace it
       * just assigned, or the winner's row when it lost the insert race. So
       * this is both the fix and the read, and there is no branch in which
       * `current` can be null. That is what guarantees the compare-and-swap
       * below always runs.
       */
      const current = await this.ensureBaseSubscriptionWithin(manager, party);

      const target = await this.requireSelectableVersion(manager, planKey, version);

      if (current.planVersionId === target.id) {
        return {
          outcome: existing ? 'already_applied' : 'selected',
          subscription: current,
        };
      }

      /*
       * The successor's id is generated BEFORE either row is written.
       *
       * Two rules pull against each other here: the superseded row must name
       * its successor (`ck_seller_subscriptions_superseded`), and the successor
       * cannot exist while the predecessor is still active
       * (`uq_seller_subscriptions_one_active_per_party`). Knowing the id up
       * front lets the predecessor be superseded naming a row that does not
       * exist yet, which the DEFERRABLE self-FK permits until COMMIT.
       */
      const successorId = uuidv7();

      // UNCONDITIONAL, where it used to be `if (current)`. That guard was the
      // `#56a` defect: it is exactly the branch two concurrent first selections
      // both took, past the only compare-and-swap on this path. `current` can
      // no longer be null, so the swap is no longer skippable.
      await this.supersede(manager, current, successorId, SUBSCRIPTION_AUDIT_REASONS.supersededBySelection);

      // Never null: `onConflict` defaults to 'throw', so a conflict raises
      // rather than returning, and the non-null assertion cannot be reached by
      // a silent path.
      const created = await this.activate(manager, {
        id: successorId,
        party,
        version: target,
        action: SUBSCRIPTION_AUDIT_ACTIONS.activated,
        reason: SUBSCRIPTION_AUDIT_REASONS.planVersionSelected,
        actorUserId,
      });
      return { outcome: 'selected', subscription: created as SellerSubscriptionEntity };
    });
  }

  /**
   * Cancel, and restore the base workspace in the same transaction.
   *
   * The restoration is not a courtesy: ADR-042 §2's invariant says every
   * eligible party has exactly one active subscription at EVERY instant, and a
   * cancellation that left the party with none would break it — reintroducing
   * the state where the platform has to guess what a seller is entitled to.
   */
  async cancel(party: OwnedSubscriberParty, actorUserId: string): Promise<SellerSubscriptionEntity> {
    return (await this.applyCancellation(party, actorUserId)).subscription;
  }

  /**
   * The same operation, reporting whether there was anything to cancel.
   *
   * ## Cancelling the base workspace is a NO-OP, not a cancel-and-recreate
   *
   * Story #69 requires it by name, and the reason is not tidiness. The
   * cancel-then-restore path below writes four rows — a cancellation, its audit
   * record, a fresh base subscription and its grant — and applied to a party
   * that is ALREADY on the base workspace it produces exactly the state it
   * started in, with a cancellation in the permanent history that no seller
   * performed against terms they had not chosen. Repeat it and the history
   * grows without bound, each entry a lie about a decision.
   *
   * So a party already on the base workspace gets its current subscription back
   * unchanged, and nothing is written or audited.
   *
   * ## "Already on the base workspace" is read from the VERSION, not a name
   *
   * `auto_assignable` is an immutable property of the plan version the
   * subscription points at, and `ex_plan_versions_single_auto_assignable`
   * guarantees at most one is active at an instant. So the question is answered
   * by the row rather than by comparing against `D-7`, which appears in no
   * production code (ADR-041 §6) — and it stays correct for a party still
   * holding a base version that has since been superseded by a newer one.
   *
   * ## Why this returns an outcome instead of raising a refusal
   *
   * The ratified vocabulary (`V33-DEC-019`) contains `selection_already_applied`
   * and no cancellation equivalent. Inventing one would widen a closed list, so
   * the no-op is reported as what it is: a successful request whose answer is
   * the unchanged workspace. The asymmetry with selection is recorded in
   * `SubscriptionSelectionAlreadyAppliedException`.
   */
  async applyCancellation(
    party: OwnedSubscriberParty,
    actorUserId: string,
  ): Promise<{ outcome: 'cancelled' | 'already_base'; subscription: SellerSubscriptionEntity }> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.findActive(party, manager);
      if (!current) throw new SubscriptionSellerNotEligibleException();

      if (await this.isBaseSubscription(manager, current)) {
        return { outcome: 'already_base', subscription: current };
      }

      await this.transition(manager, current, 'cancelled', {
        cancelledAt: new Date(),
        cancelledByUserId: actorUserId,
        cancelledByLabel: null,
      });

      await this.audit.record(manager, {
        actorUserId,
        action: SUBSCRIPTION_AUDIT_ACTIONS.cancelled,
        targetType: AUDIT_TARGET_SUBSCRIPTION,
        targetId: current.id,
        before: { lifecycleState: 'active', planKey: current.snapshotPlanKey, version: current.snapshotVersion },
        after: { lifecycleState: 'cancelled' },
        reason: SUBSCRIPTION_AUDIT_REASONS.cancelledBySeller,
      });

      const version = await this.requireAutoAssignableVersion(manager);
      const restored = await this.activate(manager, {
        party,
        version,
        action: SUBSCRIPTION_AUDIT_ACTIONS.assigned,
        reason: SUBSCRIPTION_AUDIT_REASONS.baseWorkspaceRestored,
        actorUserId: null,
      });
      return { outcome: 'cancelled', subscription: restored as SellerSubscriptionEntity };
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * Whether this subscription IS the base workspace.
   *
   * Answered from `plan_versions.auto_assignable`, which is the mechanism
   * ADR-041 §6 defines the base workspace by, rather than from the snapshot's
   * plan key — the snapshot deliberately does not carry `auto_assignable`,
   * and adding it would be the schema change this story is not authorized to
   * make.
   */
  private async isBaseSubscription(
    manager: EntityManager,
    subscription: SellerSubscriptionEntity,
  ): Promise<boolean> {
    const version = await manager
      .getRepository(CommercialPlanVersionEntity)
      .findOne({ where: { id: subscription.planVersionId }, select: { id: true, autoAssignable: true } });

    // A subscription whose plan version has vanished is not evidence that the
    // seller is on the base workspace, so this fails towards "not base" and the
    // ordinary cancellation path runs.
    return version?.autoAssignable === true;
  }

  /**
   * Insert an active subscription with a full snapshot, and issue its grant.
   *
   * Every caller is inside a transaction, and the grant and audit rows are
   * written with the SAME manager — so a failure anywhere leaves neither a
   * subscription, nor a grant, nor an audit row (ADR-042 §9).
   */
  private async activate(
    manager: EntityManager,
    input: {
      /** Pre-generated when a predecessor must name this row before it exists. */
      id?: string;
      party: OwnedSubscriberParty;
      version: CommercialPlanVersionEntity;
      action: string;
      reason: string;
      actorUserId: string | null;
      /**
       * `'ignore'` turns the insert into `ON CONFLICT DO NOTHING` and returns
       * null when the partial unique index declined it. Only the lazy-ensure
       * path wants that: a losing race there means the party already has what
       * the caller wanted. Selection and cancellation use `'throw'`, because a
       * conflict on those paths is a genuine concurrent change the caller must
       * be told about.
       */
      onConflict?: 'throw' | 'ignore';
    },
  ): Promise<SellerSubscriptionEntity | null> {
    const price = await this.snapshotPriceOf(manager, input.version);

    const repository = manager.getRepository(SellerSubscriptionEntity);
    const subscription = repository.create({
      id: input.id ?? uuidv7(),
      subscriberPartyType: input.party.partyType,
      subscriberPartyId: input.party.partyId,
      planVersionId: input.version.id,
      lifecycleState: 'active',
      // The snapshot, copied field by field. A join would make history a view
      // (ADR-042 §5).
      snapshotPlanKey: input.version.planKey,
      snapshotVersion: input.version.version,
      snapshotBillingTermDays: input.version.billingTermDays,
      snapshotIncludedBookingCredits: input.version.includedBookingCredits,
      snapshotStaffSeats: input.version.staffSeats,
      snapshotIncludedLocations: input.version.includedLocations,
      snapshotCapabilityKeys: input.version.capabilityKeys,
      snapshotCurrencyCode: price.currencyCode,
      snapshotUnitPriceToman: price.unitPriceToman,
      snapshotPriceScheduleVersionId: input.version.priceScheduleVersionId,
      effectiveAt: new Date(),
      createdByUserId: input.actorUserId,
      createdByLabel: input.actorUserId ? null : SYSTEM_ACTOR_LABEL,
    });

    if (input.onConflict === 'ignore') {
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(SellerSubscriptionEntity)
        .values(subscription)
        .orIgnore()
        .returning('id')
        .execute();
      // No row came back: the index declined it, and nothing below must run --
      // an audit row or a grant for a subscription that was not written would
      // be a fact about nothing.
      if ((result.raw as unknown[]).length === 0) return null;
    } else {
      await repository.insert(subscription);
    }

    const auditPayload = {
      action: input.action,
      targetType: AUDIT_TARGET_SUBSCRIPTION,
      targetId: subscription.id,
      after: {
        subscriberPartyType: input.party.partyType,
        lifecycleState: 'active',
        planKey: subscription.snapshotPlanKey,
        version: subscription.snapshotVersion,
        includedBookingCredits: subscription.snapshotIncludedBookingCredits,
      },
      reason: input.reason,
    };

    if (input.actorUserId) {
      await this.audit.record(manager, { ...auditPayload, actorUserId: input.actorUserId });
    } else {
      // No human took this action, so none is invented (`V33-DEC-018`).
      await this.audit.recordSystem(manager, { ...auditPayload, actorLabel: SYSTEM_ACTOR_LABEL });
    }

    await this.grants.issueForActivation(manager, subscription);

    return subscription;
  }

  private async supersede(
    manager: EntityManager,
    current: SellerSubscriptionEntity,
    successorId: string,
    reason: string,
  ): Promise<void> {
    await this.transition(manager, current, 'superseded', {
      supersededAt: new Date(),
      // Names a row that does not exist yet. Legal only because the self-FK is
      // DEFERRABLE INITIALLY DEFERRED: if the successor is never inserted, the
      // check fails at COMMIT and the whole transaction is lost, which is the
      // correct outcome.
      supersededById: successorId,
    });

    await this.audit.recordSystem(manager, {
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: SUBSCRIPTION_AUDIT_ACTIONS.superseded,
      targetType: AUDIT_TARGET_SUBSCRIPTION,
      targetId: current.id,
      before: { lifecycleState: 'active' },
      after: { lifecycleState: 'superseded' },
      reason,
    });
  }

  /**
   * COMPARE-AND-SWAP, with the expected state in the WHERE clause.
   *
   * This is what makes concurrent changes safe: two requests both read an
   * active row, both attempt the update, and exactly one matches. The loser
   * sees `affected === 0` and is refused rather than overwriting a colleague's
   * transition instant and actor.
   *
   * The same shape `CommercialCatalogueService.transitionPlanVersion` uses, for
   * the same reason.
   */
  private async transition(
    manager: EntityManager,
    current: SellerSubscriptionEntity,
    to: 'superseded' | 'cancelled',
    patch: Partial<SellerSubscriptionEntity>,
  ): Promise<void> {
    const updated = await manager
      .getRepository(SellerSubscriptionEntity)
      .update({ id: current.id, lifecycleState: 'active' }, { lifecycleState: to, ...patch });

    if (updated.affected !== 1) throw new SubscriptionChangedConcurrentlyException();
  }

  /**
   * The base workspace, resolved from the catalogue rather than a constant.
   *
   * `D-7` is never named. `ex_plan_versions_single_auto_assignable` guarantees
   * at most one auto-assignable version is active at any instant, so this
   * returns one row or refuses — it never has to choose between two
   * (ADR-041 §6).
   */
  private async requireAutoAssignableVersion(manager: EntityManager): Promise<CommercialPlanVersionEntity> {
    const now = new Date();
    const found = await manager
      .getRepository(CommercialPlanVersionEntity)
      .createQueryBuilder('v')
      .where('v.auto_assignable = true')
      .andWhere("v.lifecycle_state = 'published'")
      .andWhere('v.activation_starts_at <= :now', { now })
      .andWhere('(v.activation_ends_at IS NULL OR v.activation_ends_at > :now)', { now })
      .getOne();

    if (!found) {
      throw new SubscriptionNotConfiguredException(
        'no automatically assignable published plan version is active at this instant',
      );
    }
    return found;
  }

  /** A version a seller may move onto: published, and inside its activation window. */
  private async requireSelectableVersion(
    manager: EntityManager,
    planKey: string,
    version: number,
  ): Promise<CommercialPlanVersionEntity> {
    const now = new Date();
    const found = await manager
      .getRepository(CommercialPlanVersionEntity)
      .createQueryBuilder('v')
      .where('v.plan_key = :planKey', { planKey })
      .andWhere('v.version = :version', { version })
      .andWhere("v.lifecycle_state = 'published'")
      .andWhere('v.activation_starts_at <= :now', { now })
      .andWhere('(v.activation_ends_at IS NULL OR v.activation_ends_at > :now)', { now })
      .getOne();

    // One refusal for "no such version", "draft", "retired" and "not yet
    // active". Distinguishing them would let a caller enumerate the catalogue
    // through error messages.
    if (!found) throw new SubscriptionPlanNotSelectableException();
    return found;
  }

  /**
   * The price a subscription is snapshotted at.
   *
   * Read from the tiers of the schedule version the plan version POINTS AT, not
   * from `CommercialCatalogueService.resolvePrice`, which resolves whichever
   * version is active at an instant. For a quote that is right; for a snapshot
   * it would attach a price the seller was never offered (ADR-042 §5).
   *
   * A `seller_plan` schedule's quantity domain is exactly one, so the tier
   * covering quantity 1 is the price.
   */
  private async snapshotPriceOf(
    manager: EntityManager,
    version: CommercialPlanVersionEntity,
  ): Promise<{ currencyCode: string; unitPriceToman: number }> {
    const scheduleVersion = await manager
      .getRepository(CommercialPriceScheduleVersionEntity)
      .findOne({ where: { id: version.priceScheduleVersionId } });

    if (!scheduleVersion) {
      throw new SubscriptionNotConfiguredException('the plan version references no price schedule version');
    }

    const tiers = await manager
      .getRepository(CommercialPriceTierEntity)
      .find({ where: { scheduleVersionId: version.priceScheduleVersionId } });

    const covering = tiers.filter(
      (tier) => tier.minQuantity <= 1 && (tier.maxQuantity === null || tier.maxQuantity >= 1),
    );

    if (covering.length !== 1) {
      throw new SubscriptionNotConfiguredException(
        'the plan version’s price schedule does not price a single subscription exactly once',
      );
    }

    const unitPriceToman = covering[0].unitPriceToman;

    // Refused here so the caller learns WHY, rather than reading a constraint
    // name out of a database error. `ck_seller_subscriptions_zero_price` is
    // still what makes it impossible (ADR-042 §6).
    if (unitPriceToman !== 0) throw new SubscriptionPaidActivationUnavailableException();

    return { currencyCode: scheduleVersion.currencyCode, unitPriceToman };
  }

}
