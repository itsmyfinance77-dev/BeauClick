import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  BookingCollectionTermsV1,
  CATALOGUE_KEY_PATTERN,
  CatalogueLifecycleState,
  isPermittedLifecycleTransition,
  validateBookingCollectionTermsV1,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialActivationOverlapException,
  CommercialKeyExistsException,
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from './commercial-catalogue.exceptions';
import {
  BookingCollectionPolicyEntity,
  BookingCollectionPolicyVersionEntity,
} from './booking-collection-policy.entities';

/** PostgreSQL SQLSTATEs this service tells apart by NAME rather than by catching everything. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_RESTRICT_VIOLATION = '23001';

const AUDIT_TARGET_POLICY = 'commercial_booking_collection_policy';
const AUDIT_TARGET_POLICY_VERSION = 'commercial_booking_collection_policy_version';

/** How many times a draft creation re-derives its version number after losing a race. */
const VERSION_ALLOCATION_ATTEMPTS = 3;

/** The one contract version this story writes. A future shape is a new value, never a reinterpretation. */
const CONTRACT_VERSION = 1;

export interface WriteCollectionPolicyVersionInput {
  readonly terms: BookingCollectionTermsV1;
  /**
   * An optional FORWARD bound. There is deliberately no `activationStartsAt`
   * anywhere in this interface: publication takes it from the database clock,
   * so there is nothing for a caller to supply and nothing to validate away.
   */
  readonly activationEndsAt: Date | null;
}

export interface CreateCollectionPolicyVersionInput extends WriteCollectionPolicyVersionInput {
  readonly policyKey: string;
}

/**
 * The administrator-facing booking collection policy catalogue — V3.3 Story #83
 * (`#41d-1`), ADR-048, `V33-DEC-029`.
 *
 * ## What this service is, and what it deliberately is not
 *
 * It publishes what a collection policy SAYS. It does not assign one to
 * anybody, does not resolve one for an order, and has no caller in `commerce`.
 * Those are #104 (`#41d-2`), and the absence is asserted structurally by
 * `story-83-boundary.spec.ts` rather than merely intended.
 *
 * Like `CommercialCatalogueService`, it writes an `admin.admin_audit_log` row
 * **inside the same transaction** as every mutation, and it is NOT the enforcer
 * of the catalogue's invariants — the lifecycle allow-list, published
 * immutability, effective-window non-overlap, the deposit shape, the
 * percentage-base conditionality and non-retroactivity are all in the database.
 * Everything checked here first is checked so the caller gets a readable
 * refusal instead of a constraint name.
 *
 * ## The clock is PostgreSQL's, not this process's
 *
 * `publish` and `retire` set their instants with `now()` in the UPDATE
 * statement rather than a `new Date()` from the API host (ADR-048 §4,
 * `V33-DEC-029` Ruling 7). An application clock deciding when a commercial
 * commitment began is a commitment whose start depends on which container
 * served the request; the trigger refuses an instant more than a minute from
 * the database's own, so this is a guarantee rather than a convention.
 *
 * ## No commercial value passes through here
 *
 * Every mode, amount, rate, bound and base arrives from the administrator's
 * request and is written unchanged. There is no default, no fallback, no seed
 * and no substitution anywhere below, and a repository test enforces that
 * against this file.
 */
@Injectable()
export class BookingCollectionPolicyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  // =========================================================================
  // Policy keys
  // =========================================================================

  async listPolicies(): Promise<BookingCollectionPolicyEntity[]> {
    return this.dataSource.getRepository(BookingCollectionPolicyEntity).find({ order: { policyKey: 'ASC' } });
  }

  async createPolicy(
    actorUserId: string,
    policyKey: string,
    displayName: string,
    reason: string,
  ): Promise<BookingCollectionPolicyEntity> {
    const statedReason = this.requireReason(reason);
    this.requireKeyShape(policyKey);
    const statedName = this.requireDisplayName(displayName);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BookingCollectionPolicyEntity);
      const row = repo.create({
        policyKey,
        displayName: statedName,
        createdByUserId: actorUserId,
        createdByLabel: null,
      });

      await this.translating(() => repo.insert(row), 'collection policy key');

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.collection_policy_created',
        targetType: AUDIT_TARGET_POLICY,
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

  async listVersions(policyKey: string): Promise<BookingCollectionPolicyVersionEntity[]> {
    await this.requirePolicy(this.dataSource.manager, policyKey);
    return this.dataSource
      .getRepository(BookingCollectionPolicyVersionEntity)
      .find({ where: { policyKey }, order: { version: 'ASC' } });
  }

  async getVersion(policyKey: string, version: number): Promise<BookingCollectionPolicyVersionEntity> {
    return this.requireVersion(this.dataSource.manager, policyKey, version);
  }

  async createVersionDraft(
    actorUserId: string,
    input: CreateCollectionPolicyVersionInput,
    reason: string,
  ): Promise<BookingCollectionPolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidTerms(input.terms);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requirePolicy(manager, input.policyKey);

      const id = uuidv7();
      const version = await this.insertWithAllocatedVersion(manager, input.policyKey, (next) => ({
        id,
        policyKey: input.policyKey,
        version: next,
        lifecycleState: 'draft' as CatalogueLifecycleState,
        ...this.termsColumns(input.terms),
        contractVersion: CONTRACT_VERSION,
        // Null until publication. The database clock supplies it then.
        activationStartsAt: null,
        activationEndsAt: input.activationEndsAt,
        createdByUserId: actorUserId,
        createdByLabel: null,
      }));

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.collection_policy_version_drafted',
        targetType: AUDIT_TARGET_POLICY_VERSION,
        targetId: `${input.policyKey}@${version}`,
        reason: statedReason,
        after: this.termsSnapshot(input.terms, input.activationEndsAt),
      });

      return this.requireVersion(manager, input.policyKey, version);
    });
  }

  /**
   * Replaces a draft's terms as a WHOLE VALUE.
   *
   * Not a patch. A partial edit of a discriminated union is how a percentage
   * base survives a switch to a fixed deposit — a leftover column that the
   * database CHECK would refuse and, if it did not, a value nobody decided
   * sitting in a permanently immutable published row.
   */
  async replaceVersionDraft(
    actorUserId: string,
    policyKey: string,
    version: number,
    input: WriteCollectionPolicyVersionInput,
    reason: string,
  ): Promise<BookingCollectionPolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidTerms(input.terms);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      const existing = await this.requireVersion(manager, policyKey, version);
      const before = this.snapshotOf(existing);
      this.requireDraft(existing.lifecycleState, 'a collection policy version may only be edited while it is a draft');

      // Compare-and-swap on the lifecycle state, not a read-then-write: two
      // administrators editing while a third publishes must not have one edit
      // land on a row that became published between the check and the write.
      const updated = await this.translating(
        () =>
          manager.getRepository(BookingCollectionPolicyVersionEntity).update(
            { id: existing.id, lifecycleState: 'draft' },
            { ...this.termsColumns(input.terms), activationEndsAt: input.activationEndsAt },
          ),
        'collection policy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.collection_policy_version_updated',
        targetType: AUDIT_TARGET_POLICY_VERSION,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: this.termsSnapshot(input.terms, input.activationEndsAt),
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  async publishVersion(
    actorUserId: string,
    policyKey: string,
    version: number,
    reason: string,
  ): Promise<BookingCollectionPolicyVersionEntity> {
    return this.transitionVersion(actorUserId, policyKey, version, 'published', reason);
  }

  async retireVersion(
    actorUserId: string,
    policyKey: string,
    version: number,
    reason: string,
  ): Promise<BookingCollectionPolicyVersionEntity> {
    return this.transitionVersion(actorUserId, policyKey, version, 'retired', reason);
  }

  async discardVersionDraft(
    actorUserId: string,
    policyKey: string,
    version: number,
    reason: string,
  ): Promise<void> {
    const statedReason = this.requireReason(reason);

    await this.dataSource.transaction(async (manager) => {
      const existing = await this.requireVersion(manager, policyKey, version);
      this.requireDraft(existing.lifecycleState, 'only a draft may be discarded; a published version is permanent');

      const deleted = await this.translating(
        () =>
          manager
            .getRepository(BookingCollectionPolicyVersionEntity)
            .delete({ id: existing.id, lifecycleState: 'draft' }),
        'collection policy version',
      );
      if (deleted.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the discard landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: 'commercial.collection_policy_version_discarded',
        targetType: AUDIT_TARGET_POLICY_VERSION,
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
   * The transition, with both instants taken from PostgreSQL.
   *
   * `.set({ publishedAt: () => 'now()' })` is a raw SQL fragment rather than a
   * bound parameter, which is exactly the point: the value is produced by the
   * database evaluating the statement, so no application clock, no request
   * body and no maintenance script decides it. The trigger independently
   * refuses an instant more than a minute from the server's own.
   */
  private async transitionVersion(
    actorUserId: string,
    policyKey: string,
    version: number,
    to: CatalogueLifecycleState,
    reason: string,
  ): Promise<BookingCollectionPolicyVersionEntity> {
    const statedReason = this.requireReason(reason);
    const from: CatalogueLifecycleState = to === 'published' ? 'draft' : 'published';
    this.requirePermittedTransition(from, to);

    return this.dataSource.transaction(async (manager) => {
      const existing = await this.requireVersion(manager, policyKey, version);
      const before = this.snapshotOf(existing);

      if (to === 'published' && existing.activationEndsAt !== null) {
        // A forward bound set while drafting may have gone stale. Publishing a
        // window that has already closed would create a version that is
        // permanently immutable and never selectable.
        if (existing.activationEndsAt.getTime() <= Date.now()) {
          throw new CommercialTermsInvalidException([
            'activationEndsAt must be later than the publication instant',
          ]);
        }
      }

      const builder = manager
        .createQueryBuilder()
        .update(BookingCollectionPolicyVersionEntity)
        .where('id = :id AND lifecycle_state = :from', { id: existing.id, from });

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

      const updated = await this.translating(
        () => builder.set(patch as never).execute(),
        'collection policy version',
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
            ? 'commercial.collection_policy_version_published'
            : 'commercial.collection_policy_version_retired',
        targetType: AUDIT_TARGET_POLICY_VERSION,
        targetId: `${policyKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.requireVersion(manager, policyKey, version);
    });
  }

  /**
   * Allocates the next version number and inserts, retrying on a lost race.
   *
   * `max(version) + 1` read inside the transaction is still not safe on its
   * own: under READ COMMITTED two concurrent drafts both see the same maximum
   * and both derive the same next number. `uq_bcpv_key_version` is what decides
   * between them, and this is the insert-and-retry that follows — the same
   * idiom `CommercialCatalogueService` uses, and for the same reason: a
   * read-then-write "is this taken?" check is the bug, not the fix.
   */
  private async insertWithAllocatedVersion(
    manager: EntityManager,
    policyKey: string,
    build: (version: number) => Record<string, unknown>,
  ): Promise<number> {
    const repo = manager.getRepository(BookingCollectionPolicyVersionEntity);

    for (let attempt = 0; attempt < VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
      const highest = await repo.findOne({ where: { policyKey }, order: { version: 'DESC' } });
      const next = (highest?.version ?? 0) + 1;

      try {
        await repo.insert(build(next) as never);
        return next;
      } catch (error) {
        if (this.pgCode(error) === PG_UNIQUE_VIOLATION && attempt < VERSION_ALLOCATION_ATTEMPTS - 1) continue;
        this.rethrowTranslated(error, 'collection policy version');
      }
    }

    throw new CommercialLifecycleConflictException(
      'the next version number could not be allocated under concurrent drafting',
    );
  }

  /** Flattens the discriminated union onto the columns, leaving every unused one NULL. */
  private termsColumns(terms: BookingCollectionTermsV1): Record<string, unknown> {
    const deposit = terms.deposit;
    return {
      collectionMode: terms.collectionMode,
      depositKind: deposit.kind,
      depositAmountToman: deposit.kind === 'fixed' ? deposit.amountToman : null,
      depositBasisPoints: deposit.kind === 'percentage' ? deposit.basisPoints : null,
      depositMinimumToman: deposit.kind === 'percentage' ? deposit.minimumToman : null,
      depositMaximumToman: deposit.kind === 'percentage' ? deposit.maximumToman : null,
      percentageBase: deposit.kind === 'percentage' ? deposit.percentageBase : null,
    };
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
      throw new CommercialTermsInvalidException([
        'the key must be 1-64 characters of [A-Za-z0-9_-] starting with a letter',
      ]);
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

  private requireValidTerms(terms: BookingCollectionTermsV1): void {
    const problems = validateBookingCollectionTermsV1(terms);
    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  /**
   * The only window value a caller may supply, and it may only point forward.
   *
   * There is no `activationStartsAt` to validate: the route has no such field.
   */
  private requireForwardBound(activationEndsAt: Date | null): void {
    if (activationEndsAt === null) return;
    if (Number.isNaN(activationEndsAt.getTime())) {
      throw new CommercialTermsInvalidException(['activationEndsAt must be a valid instant']);
    }
    if (activationEndsAt.getTime() <= Date.now()) {
      throw new CommercialTermsInvalidException(['activationEndsAt must be in the future']);
    }
  }

  private async requirePolicy(manager: EntityManager, policyKey: string): Promise<BookingCollectionPolicyEntity> {
    const policy = await manager.getRepository(BookingCollectionPolicyEntity).findOne({ where: { policyKey } });
    if (!policy) throw new CommercialNotFoundException();
    return policy;
  }

  private async requireVersion(
    manager: EntityManager,
    policyKey: string,
    version: number,
  ): Promise<BookingCollectionPolicyVersionEntity> {
    const row = await manager
      .getRepository(BookingCollectionPolicyVersionEntity)
      .findOne({ where: { policyKey, version } });
    if (!row) throw new CommercialNotFoundException();
    return row;
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
   * columns and constraints, and an error body is the wrong place to start
   * publishing schema internals.
   *
   * Only three SQLSTATEs are translated, and an unknown code is RE-THROWN
   * unchanged rather than collapsed into a lifecycle conflict — a
   * `not_null_violation` or a `check_violation` from a shape this service was
   * supposed to have validated is a defect, and dressing it as an expected
   * conflict is how such a defect stays invisible.
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

  /** A flat record of enums, counts and instants — never a spread entity, never an actor. */
  private termsSnapshot(
    terms: BookingCollectionTermsV1,
    activationEndsAt: Date | null,
  ): Record<string, string | number | boolean | null> {
    const deposit = terms.deposit;
    return {
      collectionMode: terms.collectionMode,
      depositKind: deposit.kind,
      depositAmountToman: deposit.kind === 'fixed' ? deposit.amountToman : null,
      depositBasisPoints: deposit.kind === 'percentage' ? deposit.basisPoints : null,
      depositMinimumToman: deposit.kind === 'percentage' ? deposit.minimumToman : null,
      depositMaximumToman: deposit.kind === 'percentage' ? deposit.maximumToman : null,
      percentageBase: deposit.kind === 'percentage' ? deposit.percentageBase : null,
      activationEndsAt: activationEndsAt ? activationEndsAt.toISOString() : null,
    };
  }

  private snapshotOf(
    row: BookingCollectionPolicyVersionEntity,
  ): Record<string, string | number | boolean | null> {
    return {
      lifecycleState: row.lifecycleState,
      collectionMode: row.collectionMode,
      depositKind: row.depositKind,
      depositAmountToman: row.depositAmountToman,
      depositBasisPoints: row.depositBasisPoints,
      depositMinimumToman: row.depositMinimumToman,
      depositMaximumToman: row.depositMaximumToman,
      percentageBase: row.percentageBase,
      activationStartsAt: row.activationStartsAt ? row.activationStartsAt.toISOString() : null,
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
    };
  }
}
