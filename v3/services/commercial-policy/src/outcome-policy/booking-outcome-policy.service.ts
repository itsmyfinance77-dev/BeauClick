import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  BOOKING_OUTCOME_CONTRACT_VERSION,
  BookingOutcomePolicyVersionTermsV1,
  BookingOutcomeRetentionPurpose,
  BookingOutcomeRetentionRule,
  CATALOGUE_KEY_PATTERN,
  CatalogueLifecycleState,
  isPermittedLifecycleTransition,
  validateBookingOutcomePolicyVersionTermsV1,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from '../catalogue/commercial-catalogue.exceptions';
import {
  BookingOutcomePolicyEntity,
  BookingOutcomePolicyRetentionOptionEntity,
  BookingOutcomePolicyVersionEntity,
  LegalEvidenceRecordEntity,
} from './booking-outcome-policy.entities';
import {
  CommercialLegalEvidenceNotQualifyingException,
  OUTCOME_POLICY_AUDIT_ACTIONS,
  OUTCOME_POLICY_AUDIT_TARGETS,
  PG_UNIQUE_VIOLATION,
  VERSION_ALLOCATION_ATTEMPTS,
  pgCode,
  rethrowTranslated,
  translating,
} from './booking-outcome-policy.constants';
import { LegalEvidenceService } from './legal-evidence.service';

export interface WriteBookingOutcomePolicyVersionInput {
  readonly terms: BookingOutcomePolicyVersionTermsV1;
  /**
   * The evidence a `legalCap` is published against, by key. Required exactly
   * when `terms.legalCap` is present, and validated inside the transaction
   * against the record's CURRENT status and subject. Never an id.
   */
  readonly legalEvidenceKey: string | null;
  /** The optional FORWARD bound; there is no `activationStartsAt` anywhere. */
  readonly activationEndsAt: Date | null;
}

export interface CreateBookingOutcomePolicyVersionInput extends WriteBookingOutcomePolicyVersionInput {
  readonly policyKey: string;
}

/** A version together with its option rows and the evidence key it references. */
export interface BookingOutcomePolicyVersionRecord {
  readonly version: BookingOutcomePolicyVersionEntity;
  readonly options: readonly BookingOutcomePolicyRetentionOptionEntity[];
  readonly legalEvidenceKey: string | null;
}

/**
 * The administrator-facing booking-outcome policy family — V3.3 Story #42
 * (`#42a`), ADR-051 §1 and §5, `V33-DEC-039`, `V33-DEC-043`.
 *
 * ## What this service publishes
 *
 * RANGES AND SETS a seller will later choose inside (`#42b`, #159): the
 * allowed cutoff hours, the allowed no-show grace minutes and the allowed
 * retention options for each purpose — plus the administrator-fixed values
 * `V33-DEC-039` R8–R12 name and, only against qualifying Legal evidence, a
 * `legalCap`. It assigns nothing to anybody, resolves nothing for a booking
 * and has no caller in `booking` or `commerce`; that absence is asserted
 * structurally by `story-42a-boundary.spec.ts`.
 *
 * ## The invariants live in PostgreSQL
 *
 * Lifecycle, published immutability, the effective-window exclusion, the
 * ascending sets, the option shapes, one option per meaning, frozen options,
 * non-retroactivity and the Legal-evidence gate are all triggers and
 * constraints in `20260918100001_…`. Everything checked here is checked so an
 * administrator gets a readable refusal instead of a constraint name; the
 * database refuses a second time regardless.
 *
 * ## Lock order (ADR-051 *Transaction and lock ordering*)
 *
 * Publication and retirement: family row `FOR UPDATE` -> version transition
 * (compare-and-swap on the lifecycle state, instants from `now()`) -> the
 * evidence trigger -> the audit row, all in one transaction. Drafting takes
 * the family row `FOR SHARE` so a concurrent publication of a sibling cannot
 * interleave with option writes.
 *
 * ## No value passes through here
 *
 * Every set member, count, window, cap and bound arrives from the
 * administrator's request and is written unchanged. There is no default, no
 * fallback, no seed and no substitution, and a repository test enforces that
 * against this file.
 */
@Injectable()
export class BookingOutcomePolicyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    private readonly legalEvidence: LegalEvidenceService,
  ) {}

  // =========================================================================
  // Policy keys
  // =========================================================================

  async listPolicies(): Promise<BookingOutcomePolicyEntity[]> {
    return this.dataSource.getRepository(BookingOutcomePolicyEntity).find({ order: { policyKey: 'ASC' } });
  }

  async createPolicy(
    actorUserId: string,
    policyKey: string,
    displayName: string,
    reason: string,
  ): Promise<BookingOutcomePolicyEntity> {
    const statedReason = this.requireReason(reason);
    this.requireKeyShape(policyKey);
    const statedName = this.requireDisplayName(displayName);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BookingOutcomePolicyEntity);
      await translating(
        () => repo.insert({ policyKey, displayName: statedName, createdByUserId: actorUserId, createdByLabel: null }),
        'outcome policy key',
      );
      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.policyCreated,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.policy,
        targetId: policyKey,
        reason: statedReason,
        after: { policyKey, displayName: statedName },
      });
      const created = await repo.findOne({ where: { policyKey } });
      if (!created) throw new CommercialNotFoundException();
      return created;
    });
  }

  // =========================================================================
  // Versions
  // =========================================================================

  async listVersions(policyKey: string): Promise<BookingOutcomePolicyVersionRecord[]> {
    await this.requirePolicy(this.dataSource.manager, policyKey);
    const versions = await this.dataSource
      .getRepository(BookingOutcomePolicyVersionEntity)
      .find({ where: { policyKey }, order: { version: 'ASC' } });
    return this.compose(this.dataSource.manager, versions);
  }

  async getVersion(policyKey: string, version: number): Promise<BookingOutcomePolicyVersionRecord> {
    const row = await this.requireVersion(this.dataSource.manager, policyKey, version);
    const [record] = await this.compose(this.dataSource.manager, [row]);
    return record;
  }

  async createVersionDraft(
    actorUserId: string,
    input: CreateBookingOutcomePolicyVersionInput,
    reason: string,
  ): Promise<BookingOutcomePolicyVersionRecord> {
    const statedReason = this.requireReason(reason);
    this.requireValidTerms(input.terms);
    this.requireCapPairing(input);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, input.policyKey, 'share');
      const evidence = await this.resolveEvidence(manager, input);

      const id = uuidv7();
      const version = await this.insertWithAllocatedVersion(manager, input.policyKey, (next) => ({
        id,
        policyKey: input.policyKey,
        version: next,
        lifecycleState: 'draft' as CatalogueLifecycleState,
        ...this.termsColumns(input.terms, evidence?.id ?? null),
        contractVersion: BOOKING_OUTCOME_CONTRACT_VERSION,
        activationStartsAt: null,
        activationEndsAt: input.activationEndsAt,
        createdByUserId: actorUserId,
        createdByLabel: null,
      }));
      await this.writeOptions(manager, id, input.terms);

      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.versionDrafted,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.policyVersion,
        targetId: `${input.policyKey}@${version}`,
        reason: statedReason,
        after: this.termsSnapshot(input),
      });

      return this.composeOne(manager, input.policyKey, version);
    });
  }

  /** Replaces a draft — terms, options and the evidence reference — as a WHOLE VALUE. Never a patch. */
  async replaceVersionDraft(
    actorUserId: string,
    policyKey: string,
    version: number,
    input: WriteBookingOutcomePolicyVersionInput,
    reason: string,
  ): Promise<BookingOutcomePolicyVersionRecord> {
    const statedReason = this.requireReason(reason);
    this.requireValidTerms(input.terms);
    this.requireCapPairing(input);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');
      const existing = await this.requireVersion(manager, policyKey, version, 'write');
      const before = this.snapshotOf(existing);
      this.requireDraft(existing.lifecycleState, 'an outcome policy version may only be edited while it is a draft');
      const evidence = await this.resolveEvidence(manager, input);

      // Options first, under the draft's row lock: the freeze trigger permits
      // the delete only while the version is a draft, which the lock keeps true.
      await translating(
        () => manager.getRepository(BookingOutcomePolicyRetentionOptionEntity).delete({ versionId: existing.id }),
        'outcome policy version',
      );
      await this.writeOptions(manager, existing.id, input.terms);

      const updated = await translating(
        () =>
          manager.getRepository(BookingOutcomePolicyVersionEntity).update(
            { id: existing.id, lifecycleState: 'draft' },
            { ...this.termsColumns(input.terms, evidence?.id ?? null), activationEndsAt: input.activationEndsAt },
          ),
        'outcome policy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.versionUpdated,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: this.termsSnapshot(input),
      });

      return this.composeOne(manager, policyKey, version);
    });
  }

  async publishVersion(actorUserId: string, policyKey: string, version: number, reason: string) {
    return this.transitionVersion(actorUserId, policyKey, version, 'published', reason);
  }

  async retireVersion(actorUserId: string, policyKey: string, version: number, reason: string) {
    return this.transitionVersion(actorUserId, policyKey, version, 'retired', reason);
  }

  async discardVersionDraft(actorUserId: string, policyKey: string, version: number, reason: string): Promise<void> {
    const statedReason = this.requireReason(reason);

    await this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, policyKey, 'share');
      const existing = await this.requireVersion(manager, policyKey, version, 'write');
      this.requireDraft(existing.lifecycleState, 'only a draft may be discarded; a published version is permanent');

      await translating(
        () => manager.getRepository(BookingOutcomePolicyRetentionOptionEntity).delete({ versionId: existing.id }),
        'outcome policy version',
      );
      const deleted = await translating(
        () => manager.getRepository(BookingOutcomePolicyVersionEntity).delete({ id: existing.id, lifecycleState: 'draft' }),
        'outcome policy version',
      );
      if (deleted.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the discard landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.versionDiscarded,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before: this.snapshotOf(existing),
      });
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * The transition, with both instants taken from PostgreSQL (`now()` as a raw
   * fragment, never a bound parameter). The family row is locked FOR UPDATE
   * first (ADR-051 lock order); the trigger refuses an instant more than a
   * minute from the server's own, a backdated start, a cap without qualifying
   * evidence and a version with no option for a purpose.
   */
  private async transitionVersion(
    actorUserId: string,
    policyKey: string,
    version: number,
    to: CatalogueLifecycleState,
    reason: string,
  ): Promise<BookingOutcomePolicyVersionRecord> {
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
        if (existing.legalCapKind !== null) {
          // The readable half of the gate; the trigger is the authoritative one.
          const evidence = existing.legalEvidenceId
            ? await manager.getRepository(LegalEvidenceRecordEntity).findOne({ where: { id: existing.legalEvidenceId } })
            : null;
          if (!evidence || !(await this.legalEvidence.qualifiesForCap(manager, evidence.evidenceKey))) {
            throw new CommercialLegalEvidenceNotQualifyingException();
          }
        }
      }

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

      const updated = await translating(
        () =>
          manager
            .createQueryBuilder()
            .update(BookingOutcomePolicyVersionEntity)
            .set(patch as never)
            .where('id = :id AND lifecycle_state = :from', { id: existing.id, from })
            .execute(),
        'outcome policy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException(`the version was not ${from} when the transition to ${to} was attempted`);
      }

      await this.audit.record(manager, {
        actorUserId,
        action: to === 'published' ? OUTCOME_POLICY_AUDIT_ACTIONS.versionPublished : OUTCOME_POLICY_AUDIT_ACTIONS.versionRetired,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.policyVersion,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.composeOne(manager, policyKey, version);
    });
  }

  /** Allocates the next version number and inserts, retrying on a lost race (the catalogue's idiom). */
  private async insertWithAllocatedVersion(
    manager: EntityManager,
    policyKey: string,
    build: (version: number) => Record<string, unknown>,
  ): Promise<number> {
    const repo = manager.getRepository(BookingOutcomePolicyVersionEntity);
    for (let attempt = 0; attempt < VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
      const highest = await repo.findOne({ where: { policyKey }, order: { version: 'DESC' } });
      const next = (highest?.version ?? 0) + 1;
      // A unique violation aborts a PostgreSQL transaction, so the retry runs
      // under a SAVEPOINT: the losing insert is rolled back to it and the
      // transaction stays usable, which is what lets two concurrent drafts of
      // one key both succeed with distinct numbers instead of one of them
      // failing with a conflict it had no way to avoid.
      await manager.query('SAVEPOINT version_allocation');
      try {
        await repo.insert(build(next) as never);
        await manager.query('RELEASE SAVEPOINT version_allocation');
        return next;
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT version_allocation');
        if (pgCode(error) === PG_UNIQUE_VIOLATION && attempt < VERSION_ALLOCATION_ATTEMPTS - 1) continue;
        rethrowTranslated(error, 'outcome policy version');
      }
    }
    throw new CommercialLifecycleConflictException('the next version number could not be allocated under concurrent drafting');
  }

  private async writeOptions(
    manager: EntityManager,
    versionId: string,
    terms: BookingOutcomePolicyVersionTermsV1,
  ): Promise<void> {
    const rows: Partial<BookingOutcomePolicyRetentionOptionEntity>[] = [];
    const push = (purpose: BookingOutcomeRetentionPurpose, options: readonly BookingOutcomeRetentionRule[]) => {
      options.forEach((option, ordinal) => {
        rows.push({
          id: uuidv7(),
          versionId,
          purpose,
          ordinal,
          kind: option.kind,
          basisPoints: option.kind === 'percentage_of_collected' ? option.basisPoints : null,
          amountToman: option.kind === 'fixed_toman' ? option.amountToman : null,
        });
      });
    };
    push('late_cancellation', terms.lateRetentionOptions);
    push('no_show', terms.noShowRetentionOptions);
    await translating(
      () => manager.getRepository(BookingOutcomePolicyRetentionOptionEntity).insert(rows as never),
      'outcome policy version',
    );
  }

  /**
   * A cap is written only against evidence that qualifies RIGHT NOW. One
   * refusal for every non-qualifying cause (ADR-051 §5). Runs inside the
   * caller's transaction with the evidence row locked FOR SHARE, so a
   * concurrent retirement waits for this write or refuses it.
   */
  private async resolveEvidence(
    manager: EntityManager,
    input: WriteBookingOutcomePolicyVersionInput,
  ): Promise<LegalEvidenceRecordEntity | null> {
    if (input.terms.legalCap === null) return null;
    const evidence = await this.legalEvidence.qualifiesForCap(manager, input.legalEvidenceKey as string);
    if (!evidence) throw new CommercialLegalEvidenceNotQualifyingException();
    return evidence;
  }

  private requireCapPairing(input: WriteBookingOutcomePolicyVersionInput): void {
    const hasCap = input.terms.legalCap !== null;
    const hasKey = typeof input.legalEvidenceKey === 'string' && input.legalEvidenceKey.length > 0;
    if (hasCap !== hasKey) {
      throw new CommercialTermsInvalidException([
        'legalEvidenceKey must be present exactly when legalCap is present',
      ]);
    }
    if (hasKey && !CATALOGUE_KEY_PATTERN.test(input.legalEvidenceKey as string)) {
      throw new CommercialTermsInvalidException(['legalEvidenceKey has an invalid shape']);
    }
  }

  private termsColumns(terms: BookingOutcomePolicyVersionTermsV1, legalEvidenceId: string | null): Record<string, unknown> {
    const cap = terms.legalCap;
    return {
      cutoffHoursAllowed: [...terms.cutoffHoursAllowed],
      noShowGraceMinutesAllowed: [...terms.noShowGraceMinutesAllowed],
      rescheduleFreeCountBeforeCutoff: terms.rescheduleFreeCountBeforeCutoff,
      disputeWindowHours: terms.disputeWindowHours,
      bodilyHarmWindowHours: terms.bodilyHarmWindowHours,
      appealWindowHours: terms.appealWindowHours,
      caseFileRetentionDays: terms.caseFileRetentionDays,
      legalCapKind: cap === null ? null : cap.kind,
      legalCapBasisPoints: cap !== null && cap.kind === 'percentage_of_collected' ? cap.basisPoints : null,
      legalCapAmountToman: cap !== null && cap.kind === 'fixed_toman' ? cap.amountToman : null,
      legalEvidenceId,
    };
  }

  private async compose(
    manager: EntityManager,
    versions: BookingOutcomePolicyVersionEntity[],
  ): Promise<BookingOutcomePolicyVersionRecord[]> {
    if (versions.length === 0) return [];
    const options = await manager
      .getRepository(BookingOutcomePolicyRetentionOptionEntity)
      .find({ where: { versionId: In(versions.map((v) => v.id)) }, order: { purpose: 'ASC', ordinal: 'ASC' } });
    const evidenceIds = versions.map((v) => v.legalEvidenceId).filter((id): id is string => id !== null);
    const evidence =
      evidenceIds.length === 0
        ? []
        : await manager.getRepository(LegalEvidenceRecordEntity).find({ where: { id: In(evidenceIds) } });
    const keyById = new Map(evidence.map((e) => [e.id, e.evidenceKey]));
    return versions.map((version) => ({
      version,
      options: options.filter((o) => o.versionId === version.id),
      legalEvidenceKey: version.legalEvidenceId ? (keyById.get(version.legalEvidenceId) ?? null) : null,
    }));
  }

  private async composeOne(manager: EntityManager, policyKey: string, version: number) {
    const [record] = await this.compose(manager, [await this.requireVersion(manager, policyKey, version)]);
    return record;
  }

  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new CommercialReasonRequiredException();
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) throw new CommercialReasonRequiredException();
    return trimmed;
  }

  private requireDisplayName(displayName: string): string {
    if (typeof displayName !== 'string') throw new CommercialTermsInvalidException(['displayName must be a string']);
    const trimmed = displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      throw new CommercialTermsInvalidException(['displayName must be 1-120 characters once trimmed']);
    }
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

  private requireValidTerms(terms: BookingOutcomePolicyVersionTermsV1): void {
    const problems = validateBookingOutcomePolicyVersionTermsV1(terms);
    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  private requireForwardBound(activationEndsAt: Date | null): void {
    if (activationEndsAt === null) return;
    if (Number.isNaN(activationEndsAt.getTime())) {
      throw new CommercialTermsInvalidException(['activationEndsAt must be a valid instant']);
    }
    if (activationEndsAt.getTime() <= Date.now()) {
      throw new CommercialTermsInvalidException(['activationEndsAt must be in the future']);
    }
  }

  /** The family row, optionally locked: `update` for a transition, `share` for a draft write. */
  private async requirePolicy(
    manager: EntityManager,
    policyKey: string,
    lock: 'none' | 'share' | 'update' = 'none',
  ): Promise<BookingOutcomePolicyEntity> {
    const builder = manager
      .getRepository(BookingOutcomePolicyEntity)
      .createQueryBuilder('p')
      .where('p.policy_key = :policyKey', { policyKey });
    if (lock === 'update') builder.setLock('pessimistic_write');
    if (lock === 'share') builder.setLock('pessimistic_read');
    const policy = await builder.getOne();
    if (!policy) throw new CommercialNotFoundException();
    return policy;
  }

  private async requireVersion(
    manager: EntityManager,
    policyKey: string,
    version: number,
    lock: 'none' | 'write' = 'none',
  ): Promise<BookingOutcomePolicyVersionEntity> {
    const builder = manager
      .getRepository(BookingOutcomePolicyVersionEntity)
      .createQueryBuilder('v')
      .where('v.policy_key = :policyKey AND v.version = :version', { policyKey, version });
    if (lock === 'write') builder.setLock('pessimistic_write');
    const row = await builder.getOne();
    if (!row) throw new CommercialNotFoundException();
    return row;
  }

  /** A flat record of vocabulary members, counts and instants — never a spread entity, never an actor. */
  private termsSnapshot(input: WriteBookingOutcomePolicyVersionInput): Record<string, string | number | boolean | null> {
    const t = input.terms;
    return {
      cutoffHoursAllowed: t.cutoffHoursAllowed.join(','),
      lateRetentionOptions: t.lateRetentionOptions.map((o) => this.ruleLabel(o)).join(','),
      noShowGraceMinutesAllowed: t.noShowGraceMinutesAllowed.join(','),
      noShowRetentionOptions: t.noShowRetentionOptions.map((o) => this.ruleLabel(o)).join(','),
      rescheduleFreeCountBeforeCutoff: t.rescheduleFreeCountBeforeCutoff,
      disputeWindowHours: t.disputeWindowHours,
      bodilyHarmWindowHours: t.bodilyHarmWindowHours,
      appealWindowHours: t.appealWindowHours,
      caseFileRetentionDays: t.caseFileRetentionDays,
      legalCap: t.legalCap === null ? null : this.ruleLabel(t.legalCap),
      legalEvidenceKey: input.legalEvidenceKey,
      activationEndsAt: input.activationEndsAt ? input.activationEndsAt.toISOString() : null,
    };
  }

  private ruleLabel(rule: BookingOutcomeRetentionRule): string {
    if (rule.kind === 'percentage_of_collected') return `percentage_of_collected:${rule.basisPoints}`;
    if (rule.kind === 'fixed_toman') return `fixed_toman:${rule.amountToman}`;
    return rule.kind;
  }

  private snapshotOf(row: BookingOutcomePolicyVersionEntity): Record<string, string | number | boolean | null> {
    return {
      lifecycleState: row.lifecycleState,
      cutoffHoursAllowed: row.cutoffHoursAllowed.join(','),
      noShowGraceMinutesAllowed: row.noShowGraceMinutesAllowed.join(','),
      rescheduleFreeCountBeforeCutoff: row.rescheduleFreeCountBeforeCutoff,
      disputeWindowHours: row.disputeWindowHours,
      bodilyHarmWindowHours: row.bodilyHarmWindowHours,
      appealWindowHours: row.appealWindowHours,
      caseFileRetentionDays: row.caseFileRetentionDays,
      legalCapKind: row.legalCapKind,
      legalCapBasisPoints: row.legalCapBasisPoints,
      legalCapAmountToman: row.legalCapAmountToman,
      activationStartsAt: row.activationStartsAt ? row.activationStartsAt.toISOString() : null,
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
    };
  }
}
