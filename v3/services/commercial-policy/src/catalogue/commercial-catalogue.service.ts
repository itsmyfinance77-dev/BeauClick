import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  CATALOGUE_KEY_PATTERN,
  COMMERCIAL_CURRENCY,
  CatalogueLifecycleState,
  PlanVersionTermsV1,
  PriceQuoteV1,
  PriceResolutionError,
  PriceScheduleTermsV1,
  PriceSchedulePurpose,
  isPermittedLifecycleTransition,
  resolvePriceV1,
  validatePlanVersionTermsV1,
  validatePriceScheduleTermsV1,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialActivationOverlapException,
  CommercialKeyExistsException,
  CommercialLifecycleConflictException,
  CommercialNotConfiguredException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from './commercial-catalogue.exceptions';
import {
  CommercialPlanEntity,
  CommercialPlanVersionEntity,
  CommercialPriceScheduleEntity,
  CommercialPriceScheduleVersionEntity,
  CommercialPriceTierEntity,
} from './commercial-catalogue.entities';

/** PostgreSQL SQLSTATEs this service tells apart by NAME rather than by catching everything. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_RESTRICT_VIOLATION = '23001';

const AUDIT_TARGET_PLAN = 'commercial_plan';
const AUDIT_TARGET_PLAN_VERSION = 'commercial_plan_version';
const AUDIT_TARGET_SCHEDULE = 'commercial_price_schedule';
const AUDIT_TARGET_SCHEDULE_VERSION = 'commercial_price_schedule_version';

/** How many times a draft creation re-derives its version number after losing a race. */
const VERSION_ALLOCATION_ATTEMPTS = 3;

export interface ActivationWindowInput {
  readonly activationStartsAt: Date;
  readonly activationEndsAt: Date | null;
}

export interface CreatePlanVersionInput extends ActivationWindowInput {
  readonly planKey: string;
  readonly terms: PlanVersionTermsV1;
  readonly priceScheduleVersionId: string;
  readonly autoAssignable: boolean;
}

export interface UpdatePlanVersionInput extends ActivationWindowInput {
  readonly terms: PlanVersionTermsV1;
  readonly priceScheduleVersionId: string;
  readonly autoAssignable: boolean;
}

export interface CreateScheduleVersionInput extends ActivationWindowInput {
  readonly scheduleKey: string;
  readonly displayName: string;
  readonly terms: PriceScheduleTermsV1;
}

export interface UpdateScheduleVersionInput extends ActivationWindowInput {
  readonly displayName: string;
  readonly terms: PriceScheduleTermsV1;
}

export interface ResolvedScheduleVersion {
  readonly version: CommercialPriceScheduleVersionEntity;
  readonly terms: PriceScheduleTermsV1;
}

/**
 * The administrator-facing catalogue (ADR-041, Issue #40 / `#40a`).
 *
 * ## What this service is, and what it deliberately is not
 *
 * It is the ONLY writer of `commercial.*`, and it writes an
 * `admin.admin_audit_log` row **inside the same transaction** as every
 * mutation. If the audit insert fails, the mutation fails with it — the
 * guarantee `GAP-02-V3` exists to establish, and the reason
 * `AdminAuditService.record` takes an `EntityManager` rather than opening its
 * own.
 *
 * It is NOT the enforcer of the catalogue's invariants. The lifecycle
 * allow-list, the immutability of a published version, activation-window
 * non-overlap, tier contiguity and the base workspace's zero price are all in
 * the database (ADR-041 §3–§7). Everything this service checks first, it checks
 * so the caller gets a readable refusal instead of a constraint name — and it
 * translates the database's own refusal when it loses a race, because under
 * concurrency the database is the only thing that can decide.
 *
 * That division is deliberate and it is the same one `booking`'s slot claim
 * makes: a pre-check is a courtesy, and the constraint is the guarantee.
 *
 * ## The actor is never an input
 *
 * Every mutation takes `actorUserId` as its first parameter and every caller
 * passes `request.user.userId`. No method accepts an actor, owner, subscriber
 * or administrator identity in a payload object, so attributing a publication
 * to somebody else is unrepresentable rather than merely checked for.
 *
 * ## No seller-facing behaviour exists here
 *
 * No subscription, no assignment, no grant, no balance, no purchase and no
 * consumption. `resolveAutoAssignablePlanVersion` answers *which version is the
 * base workspace right now*; ASSIGNING it to a seller is #56 (`#40b`).
 */
@Injectable()
export class CommercialCatalogueService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  // =========================================================================
  // Catalogue keys
  // =========================================================================

  async createPlan(actorUserId: string, planKey: string, reason: string): Promise<CommercialPlanEntity> {
    const statedReason = this.requireReason(reason);
    this.requireKeyShape(planKey);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CommercialPlanEntity);
      const row = repo.create({ planKey, createdByUserId: actorUserId, createdByLabel: null });

      await this.translating(() => repo.insert(row), 'plan key');

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.plan_created',
        targetType: AUDIT_TARGET_PLAN,
        targetId: planKey,
        reason: statedReason,
        after: { planKey },
      });

      const created = await repo.findOne({ where: { planKey } });
      if (!created) throw new CommercialNotFoundException();
      return created;
    });
  }

  async createPriceSchedule(
    actorUserId: string,
    scheduleKey: string,
    purpose: PriceSchedulePurpose,
    reason: string,
  ): Promise<CommercialPriceScheduleEntity> {
    const statedReason = this.requireReason(reason);
    this.requireKeyShape(scheduleKey);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CommercialPriceScheduleEntity);
      const row = repo.create({ scheduleKey, purpose, createdByUserId: actorUserId, createdByLabel: null });

      await this.translating(() => repo.insert(row), 'schedule key');

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.price_schedule_created',
        targetType: AUDIT_TARGET_SCHEDULE,
        targetId: scheduleKey,
        reason: statedReason,
        after: { scheduleKey, purpose },
      });

      const created = await repo.findOne({ where: { scheduleKey } });
      if (!created) throw new CommercialNotFoundException();
      return created;
    });
  }

  // =========================================================================
  // Price schedule versions
  // =========================================================================

  async createScheduleVersionDraft(
    actorUserId: string,
    input: CreateScheduleVersionInput,
    reason: string,
  ): Promise<CommercialPriceScheduleVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidScheduleTerms(input.terms);
    this.requireValidWindow(input);

    return this.dataSource.transaction(async (manager) => {
      const schedule = await manager
        .getRepository(CommercialPriceScheduleEntity)
        .findOne({ where: { scheduleKey: input.scheduleKey } });
      if (!schedule) throw new CommercialNotFoundException();

      const id = uuidv7();
      const version = await this.insertWithAllocatedVersion(
        manager,
        CommercialPriceScheduleVersionEntity,
        'scheduleKey',
        input.scheduleKey,
        (next) => ({
          id,
          scheduleKey: input.scheduleKey,
          version: next,
          lifecycleState: 'draft' as CatalogueLifecycleState,
          displayName: input.displayName,
          currencyCode: COMMERCIAL_CURRENCY,
          minPurchaseQuantity: input.terms.minPurchaseQuantity,
          maxPurchaseQuantity: input.terms.maxPurchaseQuantity,
          uiPresetQuantities: [...input.terms.uiPresetQuantities],
          activationStartsAt: input.activationStartsAt,
          activationEndsAt: input.activationEndsAt,
          createdByUserId: actorUserId,
          createdByLabel: null,
        }),
      );

      await this.replaceTiers(manager, actorUserId, id, input.terms);

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.price_schedule_version_drafted',
        targetType: AUDIT_TARGET_SCHEDULE_VERSION,
        targetId: `${input.scheduleKey}@${version}`,
        reason: statedReason,
        after: this.scheduleSnapshot(input.terms, input),
      });

      return this.requireScheduleVersion(manager, input.scheduleKey, version);
    });
  }

  async updateScheduleVersionDraft(
    actorUserId: string,
    scheduleKey: string,
    version: number,
    input: UpdateScheduleVersionInput,
    reason: string,
  ): Promise<CommercialPriceScheduleVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidScheduleTerms(input.terms);
    this.requireValidWindow(input);

    return this.dataSource.transaction(async (manager) => {
      const existing = await this.requireScheduleVersion(manager, scheduleKey, version);
      const before = this.scheduleSnapshotOf(existing);
      this.requireDraft(existing.lifecycleState, 'a schedule version may only be edited while it is a draft');

      // Compare-and-swap on the lifecycle state, not a read-then-write. Two
      // administrators editing while a third publishes must not have one edit
      // land on a row that became published between the check and the write.
      const updated = await this.translating(
        () =>
          manager.getRepository(CommercialPriceScheduleVersionEntity).update(
            { id: existing.id, lifecycleState: 'draft' },
            {
              displayName: input.displayName,
              currencyCode: COMMERCIAL_CURRENCY,
              minPurchaseQuantity: input.terms.minPurchaseQuantity,
              maxPurchaseQuantity: input.terms.maxPurchaseQuantity,
              uiPresetQuantities: [...input.terms.uiPresetQuantities],
              activationStartsAt: input.activationStartsAt,
              activationEndsAt: input.activationEndsAt,
            },
          ),
        'schedule version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.replaceTiers(manager, actorUserId, existing.id, input.terms);

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.price_schedule_version_edited',
        targetType: AUDIT_TARGET_SCHEDULE_VERSION,
        targetId: `${scheduleKey}@${version}`,
        reason: statedReason,
        before,
        after: this.scheduleSnapshot(input.terms, input),
      });

      return this.requireScheduleVersion(manager, scheduleKey, version);
    });
  }

  async publishScheduleVersion(
    actorUserId: string,
    scheduleKey: string,
    version: number,
    reason: string,
  ): Promise<CommercialPriceScheduleVersionEntity> {
    return this.transitionScheduleVersion(actorUserId, scheduleKey, version, 'published', reason);
  }

  async retireScheduleVersion(
    actorUserId: string,
    scheduleKey: string,
    version: number,
    reason: string,
  ): Promise<CommercialPriceScheduleVersionEntity> {
    return this.transitionScheduleVersion(actorUserId, scheduleKey, version, 'retired', reason);
  }

  async discardScheduleVersionDraft(
    actorUserId: string,
    scheduleKey: string,
    version: number,
    reason: string,
  ): Promise<void> {
    const statedReason = this.requireReason(reason);

    await this.dataSource.transaction(async (manager) => {
      const existing = await this.requireScheduleVersion(manager, scheduleKey, version);
      this.requireDraft(existing.lifecycleState, 'only a draft may be discarded; a published version is permanent');

      const deleted = await this.translating(
        () =>
          manager
            .getRepository(CommercialPriceScheduleVersionEntity)
            .delete({ id: existing.id, lifecycleState: 'draft' }),
        'schedule version',
      );
      if (deleted.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the discard landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.price_schedule_version_discarded',
        targetType: AUDIT_TARGET_SCHEDULE_VERSION,
        targetId: `${scheduleKey}@${version}`,
        reason: statedReason,
        before: this.scheduleSnapshotOf(existing),
      });
    });
  }

  // =========================================================================
  // Plan versions
  // =========================================================================

  async createPlanVersionDraft(
    actorUserId: string,
    input: CreatePlanVersionInput,
    reason: string,
  ): Promise<CommercialPlanVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidPlanTerms(input.terms);
    this.requireValidWindow(input);

    return this.dataSource.transaction(async (manager) => {
      const plan = await manager.getRepository(CommercialPlanEntity).findOne({ where: { planKey: input.planKey } });
      if (!plan) throw new CommercialNotFoundException();

      const schedule = await manager
        .getRepository(CommercialPriceScheduleVersionEntity)
        .findOne({ where: { id: input.priceScheduleVersionId } });
      if (!schedule) throw new CommercialNotFoundException();

      const version = await this.insertWithAllocatedVersion(
        manager,
        CommercialPlanVersionEntity,
        'planKey',
        input.planKey,
        (next) => ({
          id: uuidv7(),
          planKey: input.planKey,
          version: next,
          lifecycleState: 'draft' as CatalogueLifecycleState,
          displayName: input.terms.displayName,
          billingTermDays: input.terms.billingTermDays,
          includedBookingCredits: input.terms.includedBookingCredits,
          staffSeats: input.terms.staffSeats,
          includedLocations: input.terms.includedLocations,
          capabilityKeys: [...input.terms.capabilityKeys],
          priceScheduleVersionId: input.priceScheduleVersionId,
          autoAssignable: input.autoAssignable,
          activationStartsAt: input.activationStartsAt,
          activationEndsAt: input.activationEndsAt,
          createdByUserId: actorUserId,
          createdByLabel: null,
        }),
      );

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.plan_version_drafted',
        targetType: AUDIT_TARGET_PLAN_VERSION,
        targetId: `${input.planKey}@${version}`,
        reason: statedReason,
        after: this.planSnapshot(input.terms, input),
      });

      return this.requirePlanVersion(manager, input.planKey, version);
    });
  }

  async updatePlanVersionDraft(
    actorUserId: string,
    planKey: string,
    version: number,
    input: UpdatePlanVersionInput,
    reason: string,
  ): Promise<CommercialPlanVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidPlanTerms(input.terms);
    this.requireValidWindow(input);

    return this.dataSource.transaction(async (manager) => {
      const existing = await this.requirePlanVersion(manager, planKey, version);
      const before = this.planSnapshotOf(existing);
      this.requireDraft(existing.lifecycleState, 'a plan version may only be edited while it is a draft');

      const schedule = await manager
        .getRepository(CommercialPriceScheduleVersionEntity)
        .findOne({ where: { id: input.priceScheduleVersionId } });
      if (!schedule) throw new CommercialNotFoundException();

      const updated = await this.translating(
        () =>
          manager.getRepository(CommercialPlanVersionEntity).update(
            { id: existing.id, lifecycleState: 'draft' },
            {
              displayName: input.terms.displayName,
              billingTermDays: input.terms.billingTermDays,
              includedBookingCredits: input.terms.includedBookingCredits,
              staffSeats: input.terms.staffSeats,
              includedLocations: input.terms.includedLocations,
              capabilityKeys: [...input.terms.capabilityKeys],
              priceScheduleVersionId: input.priceScheduleVersionId,
              autoAssignable: input.autoAssignable,
              activationStartsAt: input.activationStartsAt,
              activationEndsAt: input.activationEndsAt,
            },
          ),
        'plan version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.plan_version_edited',
        targetType: AUDIT_TARGET_PLAN_VERSION,
        targetId: `${planKey}@${version}`,
        reason: statedReason,
        before,
        after: this.planSnapshot(input.terms, input),
      });

      return this.requirePlanVersion(manager, planKey, version);
    });
  }

  async publishPlanVersion(
    actorUserId: string,
    planKey: string,
    version: number,
    reason: string,
  ): Promise<CommercialPlanVersionEntity> {
    return this.transitionPlanVersion(actorUserId, planKey, version, 'published', reason);
  }

  async retirePlanVersion(
    actorUserId: string,
    planKey: string,
    version: number,
    reason: string,
  ): Promise<CommercialPlanVersionEntity> {
    return this.transitionPlanVersion(actorUserId, planKey, version, 'retired', reason);
  }

  async discardPlanVersionDraft(
    actorUserId: string,
    planKey: string,
    version: number,
    reason: string,
  ): Promise<void> {
    const statedReason = this.requireReason(reason);

    await this.dataSource.transaction(async (manager) => {
      const existing = await this.requirePlanVersion(manager, planKey, version);
      this.requireDraft(existing.lifecycleState, 'only a draft may be discarded; a published version is permanent');

      const deleted = await this.translating(
        () => manager.getRepository(CommercialPlanVersionEntity).delete({ id: existing.id, lifecycleState: 'draft' }),
        'plan version',
      );
      if (deleted.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the discard landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.plan_version_discarded',
        targetType: AUDIT_TARGET_PLAN_VERSION,
        targetId: `${planKey}@${version}`,
        reason: statedReason,
        before: this.planSnapshotOf(existing),
      });
    });
  }

  // =========================================================================
  // Reads and resolution
  // =========================================================================

  async listPlans(): Promise<CommercialPlanEntity[]> {
    return this.dataSource.getRepository(CommercialPlanEntity).find({ order: { planKey: 'ASC' } });
  }

  async listPriceSchedules(): Promise<CommercialPriceScheduleEntity[]> {
    return this.dataSource.getRepository(CommercialPriceScheduleEntity).find({ order: { scheduleKey: 'ASC' } });
  }

  async listPlanVersions(planKey: string): Promise<CommercialPlanVersionEntity[]> {
    return this.dataSource
      .getRepository(CommercialPlanVersionEntity)
      .find({ where: { planKey }, order: { version: 'ASC' } });
  }

  async listScheduleVersions(scheduleKey: string): Promise<CommercialPriceScheduleVersionEntity[]> {
    return this.dataSource
      .getRepository(CommercialPriceScheduleVersionEntity)
      .find({ where: { scheduleKey }, order: { version: 'ASC' } });
  }

  async getPlanVersion(planKey: string, version: number): Promise<CommercialPlanVersionEntity> {
    return this.requirePlanVersion(this.dataSource.manager, planKey, version);
  }

  async getScheduleVersionWithTerms(scheduleKey: string, version: number): Promise<ResolvedScheduleVersion> {
    const row = await this.requireScheduleVersion(this.dataSource.manager, scheduleKey, version);
    return { version: row, terms: await this.termsFor(this.dataSource.manager, row) };
  }

  /**
   * The plan version selectable for a key at an instant, or a refusal.
   *
   * TWO live conditions, neither rewriting the other (ADR-041 §5): the version
   * is `published`, AND the instant falls inside its activation window.
   * Retirement is a separate fact and never edits the window, so a retired
   * version drops out of this query because of its state rather than because
   * somebody backdated its end.
   *
   * There is no "closest", "latest" or "any" fallback. `V33-DEC-009`: an
   * unconfigured plan refuses safely.
   */
  async resolveActivePlanVersion(planKey: string, at: Date): Promise<CommercialPlanVersionEntity> {
    const found = await this.activePlanVersionQuery(at).andWhere('v.plan_key = :planKey', { planKey }).getOne();
    if (!found) {
      throw new CommercialNotConfiguredException('no published plan version is active for this key at this instant');
    }
    return found;
  }

  /**
   * The base workspace, resolved from the catalogue rather than from a constant.
   *
   * This method is why `D-7` appears in no production code (ADR-041 §6). A
   * database exclusion constraint guarantees at most one auto-assignable version
   * is active at any instant, so this returns one row or refuses — it never has
   * to choose between two.
   *
   * ASSIGNING the result to a seller is #56 (`#40b`) and does not exist yet.
   */
  async resolveAutoAssignablePlanVersion(at: Date): Promise<CommercialPlanVersionEntity> {
    const found = await this.activePlanVersionQuery(at).andWhere('v.auto_assignable = true').getOne();
    if (!found) {
      throw new CommercialNotConfiguredException('no automatically assignable plan version is active at this instant');
    }
    return found;
  }

  /**
   * The exact price of a quantity under the schedule active at an instant.
   *
   * Refuses when nothing is configured, when the active version's tiers do not
   * cover their own bounds, and when the quantity is outside them. It never
   * returns zero, a nearest tier, or a default — an absent price is an absent
   * price.
   */
  async resolvePrice(scheduleKey: string, at: Date, quantity: number): Promise<PriceQuoteV1> {
    const active = await this.dataSource
      .getRepository(CommercialPriceScheduleVersionEntity)
      .createQueryBuilder('v')
      .where('v.schedule_key = :scheduleKey', { scheduleKey })
      .andWhere("v.lifecycle_state = 'published'")
      .andWhere('v.activation_starts_at <= :at', { at })
      .andWhere('(v.activation_ends_at IS NULL OR v.activation_ends_at > :at)', { at })
      .getOne();

    if (!active) {
      throw new CommercialNotConfiguredException(
        'no published price schedule version is active for this key at this instant',
      );
    }

    const terms = await this.termsFor(this.dataSource.manager, active);

    try {
      return resolvePriceV1(terms, quantity);
    } catch (error) {
      if (error instanceof PriceResolutionError) {
        // A schedule that reached `published` cannot be incomplete — the
        // publication trigger refuses it — so this branch means the data
        // changed underneath a guarantee, and a refusal is the only honest
        // answer. It is NOT translated into a zero price.
        if (error.refusal === 'schedule_incomplete') {
          throw new CommercialNotConfiguredException('the active price schedule version does not resolve a price');
        }
        throw new CommercialTermsInvalidException([error.message]);
      }
      throw error;
    }
  }

  async tiersFor(scheduleVersionId: string): Promise<CommercialPriceTierEntity[]> {
    return this.dataSource
      .getRepository(CommercialPriceTierEntity)
      .find({ where: { scheduleVersionId }, order: { minQuantity: 'ASC' } });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private activePlanVersionQuery(at: Date) {
    return this.dataSource
      .getRepository(CommercialPlanVersionEntity)
      .createQueryBuilder('v')
      .where("v.lifecycle_state = 'published'")
      .andWhere('v.activation_starts_at <= :at', { at })
      .andWhere('(v.activation_ends_at IS NULL OR v.activation_ends_at > :at)', { at });
  }

  private async termsFor(
    manager: EntityManager,
    version: CommercialPriceScheduleVersionEntity,
  ): Promise<PriceScheduleTermsV1> {
    const tiers = await manager
      .getRepository(CommercialPriceTierEntity)
      .find({ where: { scheduleVersionId: version.id }, order: { minQuantity: 'ASC' } });

    return {
      currency: COMMERCIAL_CURRENCY,
      minPurchaseQuantity: version.minPurchaseQuantity,
      maxPurchaseQuantity: version.maxPurchaseQuantity,
      uiPresetQuantities: version.uiPresetQuantities,
      tiers: tiers.map((tier) => ({
        minQuantity: tier.minQuantity,
        maxQuantity: tier.maxQuantity,
        unitPriceToman: tier.unitPriceToman,
      })),
    };
  }

  /**
   * Replaces a DRAFT version's tier set.
   *
   * Delete-then-insert rather than a diff, because a tier has no identity a
   * caller supplies: the set IS the value. The database refuses either half if
   * the parent has left draft, so this cannot partially rewrite a published
   * schedule even if it were called on one.
   */
  private async replaceTiers(
    manager: EntityManager,
    actorUserId: string,
    scheduleVersionId: string,
    terms: PriceScheduleTermsV1,
  ): Promise<void> {
    const repo = manager.getRepository(CommercialPriceTierEntity);
    await this.translating(() => repo.delete({ scheduleVersionId }), 'price tiers');

    for (const tier of terms.tiers) {
      await this.translating(
        () =>
          repo.insert({
            id: uuidv7(),
            scheduleVersionId,
            minQuantity: tier.minQuantity,
            maxQuantity: tier.maxQuantity,
            unitPriceToman: tier.unitPriceToman,
            createdByUserId: actorUserId,
            createdByLabel: null,
          }),
        'price tiers',
      );
    }
  }

  private async transitionPlanVersion(
    actorUserId: string,
    planKey: string,
    version: number,
    to: CatalogueLifecycleState,
    reason: string,
  ): Promise<CommercialPlanVersionEntity> {
    const statedReason = this.requireReason(reason);
    const from: CatalogueLifecycleState = to === 'published' ? 'draft' : 'published';
    this.requirePermittedTransition(from, to);

    return this.dataSource.transaction(async (manager) => {
      const existing = await this.requirePlanVersion(manager, planKey, version);
      const before = this.planSnapshotOf(existing);

      const now = new Date();
      const patch =
        to === 'published'
          ? { lifecycleState: to, publishedAt: now, publishedByUserId: actorUserId, publishedByLabel: null }
          : { lifecycleState: to, retiredAt: now, retiredByUserId: actorUserId, retiredByLabel: null };

      /*
       * COMPARE-AND-SWAP, with the expected state in the WHERE clause.
       *
       * This is what makes concurrent publication safe: two requests both read
       * a draft, both attempt the update, and exactly one matches a row. The
       * loser sees `affected === 0` and is refused, rather than overwriting a
       * colleague's publication instant and actor.
       */
      const updated = await this.translating(
        () => manager.getRepository(CommercialPlanVersionEntity).update({ id: existing.id, lifecycleState: from }, patch),
        'plan version',
      );

      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException(
          `the version was not ${from} when the transition to ${to} was attempted`,
        );
      }

      await this.audit.record(manager, {
        actorUserId,
        action: to === 'published' ? 'commercial.plan_version_published' : 'commercial.plan_version_retired',
        targetType: AUDIT_TARGET_PLAN_VERSION,
        targetId: `${planKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.requirePlanVersion(manager, planKey, version);
    });
  }

  private async transitionScheduleVersion(
    actorUserId: string,
    scheduleKey: string,
    version: number,
    to: CatalogueLifecycleState,
    reason: string,
  ): Promise<CommercialPriceScheduleVersionEntity> {
    const statedReason = this.requireReason(reason);
    const from: CatalogueLifecycleState = to === 'published' ? 'draft' : 'published';
    this.requirePermittedTransition(from, to);

    return this.dataSource.transaction(async (manager) => {
      const existing = await this.requireScheduleVersion(manager, scheduleKey, version);
      const before = this.scheduleSnapshotOf(existing);

      const now = new Date();
      const patch =
        to === 'published'
          ? { lifecycleState: to, publishedAt: now, publishedByUserId: actorUserId, publishedByLabel: null }
          : { lifecycleState: to, retiredAt: now, retiredByUserId: actorUserId, retiredByLabel: null };

      const updated = await this.translating(
        () =>
          manager
            .getRepository(CommercialPriceScheduleVersionEntity)
            .update({ id: existing.id, lifecycleState: from }, patch),
        'schedule version',
      );

      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException(
          `the version was not ${from} when the transition to ${to} was attempted`,
        );
      }

      await this.audit.record(manager, {
        actorUserId,
        action:
          to === 'published'
            ? 'commercial.price_schedule_version_published'
            : 'commercial.price_schedule_version_retired',
        targetType: AUDIT_TARGET_SCHEDULE_VERSION,
        targetId: `${scheduleKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.requireScheduleVersion(manager, scheduleKey, version);
    });
  }

  /**
   * Allocates the next version number and inserts, retrying on a lost race.
   *
   * `max(version) + 1` read inside the transaction is still not safe on its
   * own: under READ COMMITTED two concurrent drafts both see the same maximum
   * and both derive the same next number. `uq_*_key_version` is what decides
   * between them, and this is the insert-and-retry that follows — the same
   * idiom `referral`'s code generator uses against its own unique index, and
   * for the same reason: a read-then-write "is this taken?" check is the bug,
   * not the fix.
   */
  private async insertWithAllocatedVersion<T extends { version: number }>(
    manager: EntityManager,
    entity: new () => T,
    keyColumn: 'planKey' | 'scheduleKey',
    keyValue: string,
    build: (nextVersion: number) => Record<string, unknown>,
  ): Promise<number> {
    const repo = manager.getRepository<T>(entity);

    for (let attempt = 1; attempt <= VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
      const highest = await repo
        .createQueryBuilder('v')
        .select('MAX(v.version)', 'max')
        .where(`v.${keyColumn === 'planKey' ? 'plan_key' : 'schedule_key'} = :keyValue`, { keyValue })
        .getRawOne<{ max: string | number | null }>();

      const next = Number(highest?.max ?? 0) + 1;

      try {
        await repo.insert(build(next) as never);
        return next;
      } catch (error) {
        if (this.pgCode(error) === PG_UNIQUE_VIOLATION && attempt < VERSION_ALLOCATION_ATTEMPTS) continue;
        this.rethrowTranslated(error, 'version');
      }
    }

    throw new CommercialLifecycleConflictException('another draft claimed this version number; try again');
  }

  private async requirePlanVersion(
    manager: EntityManager,
    planKey: string,
    version: number,
  ): Promise<CommercialPlanVersionEntity> {
    const found = await manager.getRepository(CommercialPlanVersionEntity).findOne({ where: { planKey, version } });
    if (!found) throw new CommercialNotFoundException();
    return found;
  }

  private async requireScheduleVersion(
    manager: EntityManager,
    scheduleKey: string,
    version: number,
  ): Promise<CommercialPriceScheduleVersionEntity> {
    const found = await manager
      .getRepository(CommercialPriceScheduleVersionEntity)
      .findOne({ where: { scheduleKey, version } });
    if (!found) throw new CommercialNotFoundException();
    return found;
  }

  /**
   * Every mutation states why, and a blank reason is refused BEFORE anything is
   * written.
   *
   * `@MinLength(3)` on the DTO does not cover this: three spaces satisfy it.
   * The trim here is what makes the requirement true, and it is in the SERVICE
   * rather than only in the controller so a non-HTTP caller cannot skip it.
   */
  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new CommercialReasonRequiredException();
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) throw new CommercialReasonRequiredException();
    return trimmed;
  }

  private requireKeyShape(key: string): void {
    if (!CATALOGUE_KEY_PATTERN.test(key)) {
      throw new CommercialTermsInvalidException(['the key must be 1-64 characters of [A-Za-z0-9_-] starting with a letter']);
    }
  }

  private requireDraft(state: CatalogueLifecycleState, detail: string): void {
    if (state !== 'draft') throw new CommercialLifecycleConflictException(detail);
  }

  private requirePermittedTransition(from: CatalogueLifecycleState, to: CatalogueLifecycleState): void {
    if (!isPermittedLifecycleTransition(from, to)) {
      throw new CommercialLifecycleConflictException(`the lifecycle does not permit ${from} -> ${to}`);
    }
  }

  private requireValidPlanTerms(terms: PlanVersionTermsV1): void {
    const problems = validatePlanVersionTermsV1(terms);
    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  private requireValidScheduleTerms(terms: PriceScheduleTermsV1): void {
    const problems = validatePriceScheduleTermsV1(terms);
    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  private requireValidWindow(window: ActivationWindowInput): void {
    if (Number.isNaN(window.activationStartsAt.getTime())) {
      throw new CommercialTermsInvalidException(['activationStartsAt must be a valid instant']);
    }
    if (window.activationEndsAt !== null) {
      if (Number.isNaN(window.activationEndsAt.getTime())) {
        throw new CommercialTermsInvalidException(['activationEndsAt must be a valid instant']);
      }
      if (window.activationEndsAt.getTime() <= window.activationStartsAt.getTime()) {
        throw new CommercialTermsInvalidException(['activationEndsAt must be after activationStartsAt']);
      }
    }
  }

  private async translating<T>(operation: () => Promise<T>, subject: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.rethrowTranslated(error, subject);
    }
  }

  /**
   * Turns the database's own refusal into a typed one.
   *
   * The DB message is deliberately NOT echoed. A trigger's text names tables,
   * columns and constraints, and while the only callers here already hold
   * `bc_manage_commercial_plans`, an error body is the wrong place to start
   * publishing schema internals — a fixed, operation-scoped detail says the
   * same thing to a human without becoming a schema map in a log aggregator.
   */
  private rethrowTranslated(error: unknown, subject: string): never {
    const code = this.pgCode(error);

    if (code === PG_EXCLUSION_VIOLATION) throw new CommercialActivationOverlapException();
    if (code === PG_UNIQUE_VIOLATION) throw new CommercialKeyExistsException();
    if (code === PG_RESTRICT_VIOLATION) {
      throw new CommercialLifecycleConflictException(`the database refused this change to the ${subject}`);
    }

    throw error;
  }

  private pgCode(error: unknown): string | undefined {
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } } | null;
    const direct = candidate?.code;
    if (typeof direct === 'string') return direct;
    const driver = candidate?.driverError?.code;
    return typeof driver === 'string' ? driver : undefined;
  }

  private planSnapshot(
    terms: PlanVersionTermsV1,
    input: { priceScheduleVersionId: string; autoAssignable: boolean } & ActivationWindowInput,
  ): Record<string, string | number | boolean | null> {
    return {
      displayName: terms.displayName,
      billingTermDays: terms.billingTermDays,
      includedBookingCredits: terms.includedBookingCredits,
      staffSeats: terms.staffSeats,
      includedLocations: terms.includedLocations,
      // Joined rather than nested: `AuditSnapshot` is a flat record of
      // identifiers, enums and counts by design, and a spread entity is exactly
      // what that type exists to keep out of the audit log.
      capabilityKeys: terms.capabilityKeys.join(','),
      priceScheduleVersionId: input.priceScheduleVersionId,
      autoAssignable: input.autoAssignable,
      activationStartsAt: input.activationStartsAt.toISOString(),
      activationEndsAt: input.activationEndsAt ? input.activationEndsAt.toISOString() : null,
    };
  }

  private planSnapshotOf(row: CommercialPlanVersionEntity): Record<string, string | number | boolean | null> {
    return {
      lifecycleState: row.lifecycleState,
      displayName: row.displayName,
      billingTermDays: row.billingTermDays,
      includedBookingCredits: row.includedBookingCredits,
      staffSeats: row.staffSeats,
      includedLocations: row.includedLocations,
      capabilityKeys: row.capabilityKeys.join(','),
      priceScheduleVersionId: row.priceScheduleVersionId,
      autoAssignable: row.autoAssignable,
      activationStartsAt: row.activationStartsAt.toISOString(),
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
    };
  }

  private scheduleSnapshot(
    terms: PriceScheduleTermsV1,
    input: { displayName: string } & ActivationWindowInput,
  ): Record<string, string | number | boolean | null> {
    return {
      displayName: input.displayName,
      currency: terms.currency,
      minPurchaseQuantity: terms.minPurchaseQuantity,
      maxPurchaseQuantity: terms.maxPurchaseQuantity,
      tierCount: terms.tiers.length,
      activationStartsAt: input.activationStartsAt.toISOString(),
      activationEndsAt: input.activationEndsAt ? input.activationEndsAt.toISOString() : null,
    };
  }

  private scheduleSnapshotOf(
    row: CommercialPriceScheduleVersionEntity,
  ): Record<string, string | number | boolean | null> {
    return {
      lifecycleState: row.lifecycleState,
      displayName: row.displayName,
      currency: row.currencyCode,
      minPurchaseQuantity: row.minPurchaseQuantity,
      maxPurchaseQuantity: row.maxPurchaseQuantity,
      activationStartsAt: row.activationStartsAt.toISOString(),
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
    };
  }
}
