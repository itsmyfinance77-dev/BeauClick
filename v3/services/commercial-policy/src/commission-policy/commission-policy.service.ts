import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  CATALOGUE_KEY_PATTERN,
  COMMISSION_ARITHMETIC_VERSION,
  COMMISSION_BASES,
  COMMISSION_COMPONENTS,
  COMMISSION_RULE_KINDS,
  CatalogueLifecycleState,
  CommissionBase,
  CommissionComponent,
  CommissionRuleKind,
  MAX_COMMISSION_AMOUNT_TOMAN,
  MAX_COMMISSION_BASIS_POINTS,
  isPermittedLifecycleTransition,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from '../catalogue/commercial-catalogue.exceptions';
import { CommissionPolicyEntity, CommissionPolicyVersionEntity } from './commission-policy.entities';
import {
  COMMISSION_AUDIT_ACTIONS,
  COMMISSION_AUDIT_TARGETS,
  COMMISSION_VERSION_ALLOCATION_ATTEMPTS,
  PG_UNIQUE_VIOLATION,
  pgCode,
  translatingCommission,
} from './commission-policy.constants';

/** One rule, as an administrator states it. A WHOLE VALUE; never a patch. */
export interface CommissionRuleInput {
  readonly ruleKind: CommissionRuleKind;
  readonly basisPoints: number | null;
  readonly fixedToman: number | null;
  readonly base: CommissionBase | null;
  /** The optional FORWARD bound. There is no `activationStartsAt`: publication sets it from the database clock. */
  readonly activationEndsAt: Date | null;
}

/**
 * The administrator-facing commission policy family — V3.3 Story #173
 * (`#43b-1`), ADR-052 §1, `V33-DEC-040` R1.
 *
 * ## What this service publishes
 *
 * One versioned rule per component, in the four closed shapes ADR-052 §1
 * names. It assigns nothing to anybody, resolves nothing for an order, and has
 * no caller in `commerce` or `financial`: the snapshot that will read these
 * rows is `#43b-2` (#192) and recognition is `#43c`. That absence is asserted
 * structurally by `story-43b1-boundary.spec.ts`.
 *
 * ## The invariants live in PostgreSQL
 *
 * The four-shape matrix, the lifecycle, published immutability, the
 * effective-window exclusion, one key per component, non-retroactivity and the
 * no-tolerance publication instant are constraints and triggers in
 * `20260922100001_…`. Everything checked here is checked so an administrator
 * gets a readable refusal instead of a constraint name; the database refuses a
 * second time regardless, and the pg-spec proves it by bypassing this service.
 *
 * ## The publication instant is the DATABASE's, exactly
 *
 * `publishedAt` and `activationStartsAt` are written as the SQL expression
 * `now()` — the transaction timestamp — never as a JavaScript `Date`. ADR-052
 * §1 requires equality with no tolerance, so an application-host clock, even
 * one a few milliseconds off, would be refused by the trigger. That is the
 * intended design: the instant a commission rule becomes binding is the
 * database's fact, not the API host's.
 *
 * ## No value passes through here
 *
 * Every rate, amount and base arrives from the administrator's request and is
 * written unchanged. There is no default, no fallback, no seed and no
 * substitution — `no-hardcoded-commission-rate.spec.ts` enforces that against
 * this file.
 */
@Injectable()
export class CommissionPolicyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  // =========================================================================
  // Policy keys
  // =========================================================================

  async listPolicies(): Promise<CommissionPolicyEntity[]> {
    return this.dataSource.getRepository(CommissionPolicyEntity).find({ order: { component: 'ASC' } });
  }

  async createPolicy(
    actorUserId: string,
    policyKey: string,
    component: CommissionComponent,
    displayName: string,
    reason: string,
  ): Promise<CommissionPolicyEntity> {
    const statedReason = this.requireReason(reason);
    this.requireKeyShape(policyKey);
    this.requireComponent(component);
    const statedName = this.requireDisplayName(displayName);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CommissionPolicyEntity);
      await translatingCommission(
        () =>
          repo.insert({
            policyKey,
            component,
            displayName: statedName,
            createdByUserId: actorUserId,
            createdByLabel: null,
          }),
        'commission policy key',
      );
      await this.audit.record(manager, {
        actorUserId,
        action: COMMISSION_AUDIT_ACTIONS.policyCreated,
        targetType: COMMISSION_AUDIT_TARGETS.policy,
        targetId: policyKey,
        reason: statedReason,
        after: { policyKey, component, displayName: statedName },
      });
      const created = await repo.findOne({ where: { policyKey } });
      if (!created) throw new CommercialNotFoundException();
      return created;
    });
  }

  // =========================================================================
  // Versions
  // =========================================================================

  async listVersions(policyKey: string): Promise<CommissionPolicyVersionEntity[]> {
    await this.requirePolicy(this.dataSource.manager, policyKey);
    return this.dataSource
      .getRepository(CommissionPolicyVersionEntity)
      .find({ where: { policyKey }, order: { version: 'ASC' } });
  }

  async getVersion(policyKey: string, version: number): Promise<CommissionPolicyVersionEntity> {
    return this.requireVersion(this.dataSource.manager, policyKey, version);
  }

  async createVersionDraft(
    actorUserId: string,
    policyKey: string,
    input: CommissionRuleInput,
    reason: string,
  ): Promise<CommissionPolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidRule(input);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');

      const version = await this.insertWithAllocatedVersion(manager, policyKey, (next) => ({
        id: uuidv7(),
        policyKey,
        version: next,
        lifecycleState: 'draft' as CatalogueLifecycleState,
        ...this.ruleColumns(input),
        arithmeticVersion: COMMISSION_ARITHMETIC_VERSION,
        activationStartsAt: null,
        activationEndsAt: input.activationEndsAt,
        createdByUserId: actorUserId,
        createdByLabel: null,
      }));

      await this.audit.record(manager, {
        actorUserId,
        action: COMMISSION_AUDIT_ACTIONS.versionDrafted,
        targetType: COMMISSION_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        after: this.ruleSnapshot(input),
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  /** Replaces a draft's rule as a WHOLE VALUE. A published version is never edited. */
  async replaceVersionDraft(
    actorUserId: string,
    policyKey: string,
    version: number,
    input: CommissionRuleInput,
    reason: string,
  ): Promise<CommissionPolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidRule(input);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');
      const existing = await this.requireVersion(manager, policyKey, version, 'write');
      const before = this.snapshotOf(existing);
      if (existing.lifecycleState !== 'draft') {
        throw new CommercialLifecycleConflictException('a commission rule may only be edited while it is a draft');
      }

      const updated = await translatingCommission(
        () =>
          manager
            .getRepository(CommissionPolicyVersionEntity)
            .update(
              { id: existing.id, lifecycleState: 'draft' },
              { ...this.ruleColumns(input), activationEndsAt: input.activationEndsAt },
            ),
        'commission policy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: COMMISSION_AUDIT_ACTIONS.versionUpdated,
        targetType: COMMISSION_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: this.ruleSnapshot(input),
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

      await translatingCommission(
        () => manager.getRepository(CommissionPolicyVersionEntity).delete({ id: existing.id, lifecycleState: 'draft' }),
        'commission policy version',
      );
      await this.audit.record(manager, {
        actorUserId,
        action: COMMISSION_AUDIT_ACTIONS.versionDiscarded,
        targetType: COMMISSION_AUDIT_TARGETS.policyVersion,
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
  ): Promise<CommissionPolicyVersionEntity> {
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
       * `now()` as a SQL expression, not a `Date` from this process. The
       * trigger compares for EQUALITY with the transaction timestamp (ADR-052
       * §1, no tolerance), so any instant computed here — however close —
       * would be refused. `activationStartsAt` takes the same expression, so a
       * rule activates exactly when it is published unless a later story adds
       * a scheduled activation.
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

      const updated = await translatingCommission(
        () =>
          manager
            .createQueryBuilder()
            .update(CommissionPolicyVersionEntity)
            .set(patch as never)
            .where('id = :id AND lifecycle_state = :from', { id: existing.id, from })
            .execute(),
        'commission policy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException(
          `the version was not ${from} when the transition to ${to} was attempted`,
        );
      }

      await this.audit.record(manager, {
        actorUserId,
        action: to === 'published' ? COMMISSION_AUDIT_ACTIONS.versionPublished : COMMISSION_AUDIT_ACTIONS.versionRetired,
        targetType: COMMISSION_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  /**
   * `MAX(version) + 1`, retried on the unique violation rather than serialised
   * behind a lock: two administrators drafting against one key at the same
   * instant is rare, and the constraint — not the read — is what decides.
   */
  private async insertWithAllocatedVersion(
    manager: EntityManager,
    policyKey: string,
    build: (next: number) => Partial<CommissionPolicyVersionEntity>,
  ): Promise<number> {
    const repo = manager.getRepository(CommissionPolicyVersionEntity);
    for (let attempt = 1; attempt <= COMMISSION_VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
      const [highest] = await repo.find({ where: { policyKey }, order: { version: 'DESC' }, take: 1 });
      const next = (highest?.version ?? 0) + 1;
      try {
        await repo.insert(build(next) as CommissionPolicyVersionEntity);
        return next;
      } catch (error) {
        if (pgCode(error) === PG_UNIQUE_VIOLATION && attempt < COMMISSION_VERSION_ALLOCATION_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new CommercialLifecycleConflictException('another administrator is drafting against this policy key');
  }

  private ruleColumns(input: CommissionRuleInput) {
    return {
      ruleKind: input.ruleKind,
      basisPoints: input.basisPoints,
      fixedToman: input.fixedToman,
      base: input.base,
    };
  }

  private ruleSnapshot(input: CommissionRuleInput) {
    return {
      ruleKind: input.ruleKind,
      basisPoints: input.basisPoints,
      fixedToman: input.fixedToman,
      base: input.base,
      activationEndsAt: input.activationEndsAt?.toISOString() ?? null,
      arithmeticVersion: COMMISSION_ARITHMETIC_VERSION,
    };
  }

  private snapshotOf(row: CommissionPolicyVersionEntity) {
    return {
      lifecycleState: row.lifecycleState,
      ruleKind: row.ruleKind,
      basisPoints: row.basisPoints,
      fixedToman: row.fixedToman,
      base: row.base,
      activationStartsAt: row.activationStartsAt?.toISOString() ?? null,
      activationEndsAt: row.activationEndsAt?.toISOString() ?? null,
    };
  }

  /**
   * The readable half of the CHECK matrix. Stated positively, shape by shape,
   * so an administrator is told which field is wrong rather than being handed
   * `ck_cpv_shape`.
   */
  private requireValidRule(input: CommissionRuleInput): void {
    const problems: string[] = [];

    if (!COMMISSION_RULE_KINDS.includes(input.ruleKind)) {
      throw new CommercialTermsInvalidException([`ruleKind must be one of ${COMMISSION_RULE_KINDS.join(', ')}`]);
    }
    if (input.base !== null && !COMMISSION_BASES.includes(input.base)) {
      problems.push(`base must be one of ${COMMISSION_BASES.join(', ')}`);
    }
    if (input.basisPoints !== null) {
      if (!Number.isInteger(input.basisPoints) || input.basisPoints < 0 || input.basisPoints > MAX_COMMISSION_BASIS_POINTS) {
        problems.push(`basisPoints must be an integer between 0 and ${MAX_COMMISSION_BASIS_POINTS}`);
      }
    }
    if (input.fixedToman !== null) {
      if (!Number.isInteger(input.fixedToman) || input.fixedToman < 0 || input.fixedToman > MAX_COMMISSION_AMOUNT_TOMAN) {
        problems.push(`fixedToman must be an integer between 0 and ${MAX_COMMISSION_AMOUNT_TOMAN}`);
      }
    }

    const has = {
      bp: input.basisPoints !== null,
      fixed: input.fixedToman !== null,
      base: input.base !== null,
    };

    switch (input.ruleKind) {
      case 'zero':
        if (has.bp || has.fixed || has.base) problems.push('a zero rule carries no basisPoints, fixedToman or base');
        break;
      case 'percentage':
        if (!has.bp) problems.push('a percentage rule requires basisPoints');
        if (!has.base) problems.push('a percentage rule requires a base');
        if (has.fixed) problems.push('a percentage rule carries no fixedToman');
        break;
      case 'fixed':
        if (!has.fixed) problems.push('a fixed rule requires fixedToman');
        if (has.fixed && input.fixedToman !== null && input.fixedToman <= 0) {
          problems.push('a fixed rule requires fixedToman above zero — publish a zero rule to charge nothing');
        }
        if (has.bp) problems.push('a fixed rule carries no basisPoints');
        if (has.base) problems.push('a fixed rule carries no base');
        break;
      case 'hybrid':
        if (!has.bp) problems.push('a hybrid rule requires basisPoints');
        if (!has.fixed) problems.push('a hybrid rule requires fixedToman, which may be zero');
        if (!has.base) problems.push('a hybrid rule requires a base');
        break;
    }

    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  private requireForwardBound(activationEndsAt: Date | null): void {
    if (activationEndsAt !== null && activationEndsAt.getTime() <= Date.now()) {
      throw new CommercialTermsInvalidException(['activationEndsAt must be in the future']);
    }
  }

  private requireComponent(component: CommissionComponent): void {
    if (!COMMISSION_COMPONENTS.includes(component)) {
      throw new CommercialTermsInvalidException([`component must be one of ${COMMISSION_COMPONENTS.join(', ')}`]);
    }
  }

  private requireKeyShape(policyKey: string): void {
    if (!CATALOGUE_KEY_PATTERN.test(policyKey)) {
      throw new CommercialTermsInvalidException(['policyKey must match the catalogue key shape']);
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
  ): Promise<CommissionPolicyEntity> {
    const query = manager
      .getRepository(CommissionPolicyEntity)
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
  ): Promise<CommissionPolicyVersionEntity> {
    const query = manager
      .getRepository(CommissionPolicyVersionEntity)
      .createQueryBuilder('version')
      .where('version.policy_key = :policyKey AND version.version = :version', { policyKey, version });
    if (lock === 'write') query.setLock('pessimistic_write');
    const found = await query.getOne();
    if (!found) throw new CommercialNotFoundException();
    return found;
  }
}
