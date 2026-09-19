import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  CATALOGUE_KEY_PATTERN,
  CatalogueLifecycleState,
  MAX_RESERVE_BASIS_POINTS,
  MAX_SETTLEMENT_AMOUNT_TOMAN,
  MAX_SETTLEMENT_INTERVAL_DAYS,
  SELLER_RISK_CLASSES,
  SellerRiskClass,
  isPermittedLifecycleTransition,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from '../catalogue/commercial-catalogue.exceptions';
import {
  SETTLEMENT_AUDIT_ACTIONS,
  SETTLEMENT_AUDIT_TARGETS,
  SETTLEMENT_VERSION_ALLOCATION_ATTEMPTS,
  PG_UNIQUE_VIOLATION,
  pgCode,
  translatingSettlement,
} from './settlement-schedule.constants';
import {
  SettlementSchedulePolicyEntity,
  SettlementSchedulePolicyVersionEntity,
} from './settlement-schedule.entities';

/** One schedule, as an administrator states it. A WHOLE VALUE; never a patch. */
export interface SettlementScheduleInput {
  readonly settlementIntervalDays: number;
  /** Null means NO minimum. Zero would mean "propose any amount", which is a different decision. */
  readonly minimumPayoutToman: number | null;
  readonly reserveBasisPoints: number | null;
  readonly reserveCapToman: number | null;
  /** The optional FORWARD bound; publication sets the start from the database clock. */
  readonly activationEndsAt: Date | null;
}

/**
 * The administrator-facing settlement schedule family — V3.3 Story #175
 * (`#43d`), ADR-052 §1 and §8.
 *
 * ## What this service publishes
 *
 * How often a seller's money is proposed for settlement, the minimum worth
 * paying out, and the reserve held back — per `(plan_key, risk_class)`. It
 * proposes nothing, settles nothing and holds nothing back by itself: `#43e`
 * (#176) is the first reader, and it is `gate:external` behind the payout
 * rail. `story-43d-boundary.spec.ts` asserts that absence structurally.
 *
 * ## The invariants live in PostgreSQL
 *
 * Lifecycle, published immutability, the effective-window exclusion, one key
 * per pair, non-retroactivity and the no-tolerance publication instant are
 * constraints and triggers in `20260924100001_…`. Everything checked here is
 * checked so an administrator gets a readable refusal instead of a constraint
 * name; the database refuses a second time regardless, and the pg-spec proves
 * it by bypassing this service.
 *
 * ## No value passes through here, and "weekly" is not one
 *
 * Every interval, minimum, rate and cap arrives from the administrator's
 * request and is written unchanged. Seven appears nowhere in this file: if
 * the platform settles weekly it is because somebody published 7, and the row
 * records who and when.
 */
@Injectable()
export class SettlementScheduleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  // =========================================================================
  // Policy keys
  // =========================================================================

  async listPolicies(): Promise<SettlementSchedulePolicyEntity[]> {
    return this.dataSource
      .getRepository(SettlementSchedulePolicyEntity)
      .find({ order: { planKey: 'ASC', riskClass: 'ASC' } });
  }

  async createPolicy(
    actorUserId: string,
    policyKey: string,
    planKey: string,
    riskClass: SellerRiskClass,
    displayName: string,
    reason: string,
  ): Promise<SettlementSchedulePolicyEntity> {
    const statedReason = this.requireReason(reason);
    this.requireKeyShape(policyKey, 'policyKey');
    this.requireKeyShape(planKey, 'planKey');
    this.requireRiskClass(riskClass);
    const statedName = this.requireDisplayName(displayName);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SettlementSchedulePolicyEntity);
      await translatingSettlement(
        () =>
          repo.insert({
            policyKey,
            planKey,
            riskClass,
            displayName: statedName,
            createdByUserId: actorUserId,
            createdByLabel: null,
          }),
        'settlement schedule key',
      );
      await this.audit.record(manager, {
        actorUserId,
        action: SETTLEMENT_AUDIT_ACTIONS.policyCreated,
        targetType: SETTLEMENT_AUDIT_TARGETS.policy,
        targetId: policyKey,
        reason: statedReason,
        after: { policyKey, planKey, riskClass, displayName: statedName },
      });
      const created = await repo.findOne({ where: { policyKey } });
      if (!created) throw new CommercialNotFoundException();
      return created;
    });
  }

  // =========================================================================
  // Versions
  // =========================================================================

  async listVersions(policyKey: string): Promise<SettlementSchedulePolicyVersionEntity[]> {
    await this.requirePolicy(this.dataSource.manager, policyKey);
    return this.dataSource
      .getRepository(SettlementSchedulePolicyVersionEntity)
      .find({ where: { policyKey }, order: { version: 'ASC' } });
  }

  async getVersion(policyKey: string, version: number): Promise<SettlementSchedulePolicyVersionEntity> {
    return this.requireVersion(this.dataSource.manager, policyKey, version);
  }

  async createVersionDraft(
    actorUserId: string,
    policyKey: string,
    input: SettlementScheduleInput,
    reason: string,
  ): Promise<SettlementSchedulePolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidSchedule(input);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');
      const version = await this.insertWithAllocatedVersion(manager, policyKey, (next) => ({
        id: uuidv7(),
        policyKey,
        version: next,
        lifecycleState: 'draft' as CatalogueLifecycleState,
        ...this.scheduleColumns(input),
        activationStartsAt: null,
        activationEndsAt: input.activationEndsAt,
        createdByUserId: actorUserId,
        createdByLabel: null,
      }));

      await this.audit.record(manager, {
        actorUserId,
        action: SETTLEMENT_AUDIT_ACTIONS.versionDrafted,
        targetType: SETTLEMENT_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        after: this.scheduleSnapshot(input),
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  /** Replaces a draft's schedule as a WHOLE VALUE. A published version is never edited. */
  async replaceVersionDraft(
    actorUserId: string,
    policyKey: string,
    version: number,
    input: SettlementScheduleInput,
    reason: string,
  ): Promise<SettlementSchedulePolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidSchedule(input);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');
      const existing = await this.requireVersion(manager, policyKey, version, 'write');
      const before = this.snapshotOf(existing);
      if (existing.lifecycleState !== 'draft') {
        throw new CommercialLifecycleConflictException('a settlement schedule may only be edited while it is a draft');
      }

      const updated = await translatingSettlement(
        () =>
          manager
            .getRepository(SettlementSchedulePolicyVersionEntity)
            .update(
              { id: existing.id, lifecycleState: 'draft' },
              { ...this.scheduleColumns(input), activationEndsAt: input.activationEndsAt },
            ),
        'settlement schedule version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: SETTLEMENT_AUDIT_ACTIONS.versionUpdated,
        targetType: SETTLEMENT_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: this.scheduleSnapshot(input),
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  async discardVersionDraft(actorUserId: string, policyKey: string, version: number, reason: string): Promise<void> {
    const statedReason = this.requireReason(reason);

    await this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');
      const existing = await this.requireVersion(manager, policyKey, version, 'write');
      if (existing.lifecycleState !== 'draft') {
        throw new CommercialLifecycleConflictException('only a draft may be discarded');
      }

      await translatingSettlement(
        () =>
          manager
            .getRepository(SettlementSchedulePolicyVersionEntity)
            .delete({ id: existing.id, lifecycleState: 'draft' }),
        'settlement schedule version',
      );
      await this.audit.record(manager, {
        actorUserId,
        action: SETTLEMENT_AUDIT_ACTIONS.versionDiscarded,
        targetType: SETTLEMENT_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before: this.snapshotOf(existing),
      });
    });
  }

  async publishVersion(actorUserId: string, policyKey: string, version: number, reason: string) {
    return this.transitionVersion(actorUserId, policyKey, version, 'published', reason);
  }

  async retireVersion(actorUserId: string, policyKey: string, version: number, reason: string) {
    return this.transitionVersion(actorUserId, policyKey, version, 'retired', reason);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async transitionVersion(
    actorUserId: string,
    policyKey: string,
    version: number,
    to: CatalogueLifecycleState,
    reason: string,
  ): Promise<SettlementSchedulePolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    const from: CatalogueLifecycleState = to === 'published' ? 'draft' : 'published';
    if (!isPermittedLifecycleTransition(from, to)) {
      throw new CommercialLifecycleConflictException(`the lifecycle does not permit ${from} -> ${to}`);
    }

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'update');
      const existing = await this.requireVersion(manager, policyKey, version, 'write');
      const before = this.snapshotOf(existing);

      if (to === 'published') {
        if (existing.lifecycleState !== 'draft') {
          throw new CommercialLifecycleConflictException('only a draft may be published');
        }
        if (existing.activationEndsAt !== null && existing.activationEndsAt.getTime() <= Date.now()) {
          throw new CommercialTermsInvalidException(['activationEndsAt must be later than the publication instant']);
        }
      }

      /*
       * `now()` as SQL, not a `Date` from this process: the trigger compares
       * for EQUALITY with the transaction timestamp (ADR-052 §1, no
       * tolerance), so any instant computed here would be refused.
       */
      const patch =
        to === 'published'
          ? {
              lifecycleState: to,
              publishedAt: () => 'now()',
              activationStartsAt: () => 'now()',
              publishedByUserId: actorUserId,
              publishedByLabel: null,
            }
          : {
              lifecycleState: to,
              retiredAt: () => 'now()',
              retiredByUserId: actorUserId,
              retiredByLabel: null,
            };

      const updated = await translatingSettlement(
        () =>
          manager
            .createQueryBuilder()
            .update(SettlementSchedulePolicyVersionEntity)
            .set(patch as never)
            .where('id = :id AND lifecycle_state = :from', { id: existing.id, from })
            .execute(),
        'settlement schedule version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException(
          `the version was not ${from} when the transition to ${to} was attempted`,
        );
      }

      await this.audit.record(manager, {
        actorUserId,
        action:
          to === 'published' ? SETTLEMENT_AUDIT_ACTIONS.versionPublished : SETTLEMENT_AUDIT_ACTIONS.versionRetired,
        targetType: SETTLEMENT_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  private async insertWithAllocatedVersion(
    manager: EntityManager,
    policyKey: string,
    build: (next: number) => Partial<SettlementSchedulePolicyVersionEntity>,
  ): Promise<number> {
    const repo = manager.getRepository(SettlementSchedulePolicyVersionEntity);
    for (let attempt = 1; attempt <= SETTLEMENT_VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
      const [highest] = await repo.find({ where: { policyKey }, order: { version: 'DESC' }, take: 1 });
      const next = (highest?.version ?? 0) + 1;
      try {
        await repo.insert(build(next) as SettlementSchedulePolicyVersionEntity);
        return next;
      } catch (error) {
        if (pgCode(error) === PG_UNIQUE_VIOLATION && attempt < SETTLEMENT_VERSION_ALLOCATION_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new CommercialLifecycleConflictException('another administrator is drafting against this policy key');
  }

  private scheduleColumns(input: SettlementScheduleInput) {
    return {
      settlementIntervalDays: input.settlementIntervalDays,
      minimumPayoutToman: input.minimumPayoutToman,
      reserveBasisPoints: input.reserveBasisPoints,
      reserveCapToman: input.reserveCapToman,
    };
  }

  private scheduleSnapshot(input: SettlementScheduleInput) {
    return {
      ...this.scheduleColumns(input),
      activationEndsAt: input.activationEndsAt?.toISOString() ?? null,
    };
  }

  private snapshotOf(row: SettlementSchedulePolicyVersionEntity) {
    return {
      lifecycleState: row.lifecycleState,
      settlementIntervalDays: row.settlementIntervalDays,
      minimumPayoutToman: row.minimumPayoutToman,
      reserveBasisPoints: row.reserveBasisPoints,
      reserveCapToman: row.reserveCapToman,
      activationStartsAt: row.activationStartsAt?.toISOString() ?? null,
      activationEndsAt: row.activationEndsAt?.toISOString() ?? null,
    };
  }

  /** The readable half of the CHECKs, stated field by field. */
  private requireValidSchedule(input: SettlementScheduleInput): void {
    const problems: string[] = [];

    if (!Number.isInteger(input.settlementIntervalDays) || input.settlementIntervalDays <= 0) {
      problems.push('settlementIntervalDays must be a positive integer — there is no default cadence');
    } else if (input.settlementIntervalDays > MAX_SETTLEMENT_INTERVAL_DAYS) {
      problems.push(`settlementIntervalDays must not exceed ${MAX_SETTLEMENT_INTERVAL_DAYS}`);
    }

    if (input.minimumPayoutToman !== null) {
      if (
        !Number.isInteger(input.minimumPayoutToman) ||
        input.minimumPayoutToman < 0 ||
        input.minimumPayoutToman > MAX_SETTLEMENT_AMOUNT_TOMAN
      ) {
        problems.push(`minimumPayoutToman must be an integer between 0 and ${MAX_SETTLEMENT_AMOUNT_TOMAN}`);
      }
    }

    if (input.reserveBasisPoints !== null) {
      if (
        !Number.isInteger(input.reserveBasisPoints) ||
        input.reserveBasisPoints < 0 ||
        input.reserveBasisPoints > MAX_RESERVE_BASIS_POINTS
      ) {
        problems.push(`reserveBasisPoints must be an integer between 0 and ${MAX_RESERVE_BASIS_POINTS}`);
      }
    }

    if (input.reserveCapToman !== null) {
      if (
        !Number.isInteger(input.reserveCapToman) ||
        input.reserveCapToman < 0 ||
        input.reserveCapToman > MAX_SETTLEMENT_AMOUNT_TOMAN
      ) {
        problems.push(`reserveCapToman must be an integer between 0 and ${MAX_SETTLEMENT_AMOUNT_TOMAN}`);
      }
    }

    if (input.activationEndsAt !== null && input.activationEndsAt.getTime() <= Date.now()) {
      problems.push('activationEndsAt must be in the future');
    }

    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  private requireRiskClass(riskClass: SellerRiskClass): void {
    if (!SELLER_RISK_CLASSES.includes(riskClass)) {
      throw new CommercialTermsInvalidException([`riskClass must be one of ${SELLER_RISK_CLASSES.join(', ')}`]);
    }
  }

  private requireKeyShape(key: string, field: string): void {
    if (!CATALOGUE_KEY_PATTERN.test(key)) {
      throw new CommercialTermsInvalidException([`${field} must match the catalogue key shape`]);
    }
  }

  private requireDisplayName(displayName: string): string {
    const trimmed = (displayName ?? '').trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      throw new CommercialTermsInvalidException(['displayName must be between 1 and 120 characters']);
    }
    return trimmed;
  }

  private requireReason(reason: string): string {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length === 0) throw new CommercialReasonRequiredException();
    return trimmed;
  }

  private async requirePolicy(
    manager: EntityManager,
    policyKey: string,
    lock?: 'share' | 'update',
  ): Promise<SettlementSchedulePolicyEntity> {
    const query = manager
      .getRepository(SettlementSchedulePolicyEntity)
      .createQueryBuilder('policy')
      .where('policy.policy_key = :policyKey', { policyKey });
    if (lock === 'share') query.setLock('pessimistic_read');
    if (lock === 'update') query.setLock('pessimistic_write');
    const found = await query.getOne();
    if (!found) throw new CommercialNotFoundException();
    return found;
  }

  private async requireVersion(
    manager: EntityManager,
    policyKey: string,
    version: number,
    lock?: 'write',
  ): Promise<SettlementSchedulePolicyVersionEntity> {
    const query = manager
      .getRepository(SettlementSchedulePolicyVersionEntity)
      .createQueryBuilder('version')
      .where('version.policy_key = :policyKey AND version.version = :version', { policyKey, version });
    if (lock === 'write') query.setLock('pessimistic_write');
    const found = await query.getOne();
    if (!found) throw new CommercialNotFoundException();
    return found;
  }
}
