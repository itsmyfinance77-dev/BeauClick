import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  BOOKING_OUTCOME_CONTRACT_VERSION,
  CATALOGUE_KEY_PATTERN,
  CatalogueLifecycleState,
  CustomerPolicyCopyVersionTermsV1,
  isPermittedLifecycleTransition,
  utf8ByteLength,
  validateCustomerPolicyCopyVersionTermsV1,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from '../catalogue/commercial-catalogue.exceptions';
import { CustomerPolicyCopyEntity, CustomerPolicyCopyVersionEntity } from './booking-outcome-policy.entities';
import {
  OUTCOME_POLICY_AUDIT_ACTIONS,
  OUTCOME_POLICY_AUDIT_TARGETS,
  PG_UNIQUE_VIOLATION,
  VERSION_ALLOCATION_ATTEMPTS,
  pgCode,
  rethrowTranslated,
  translating,
} from './booking-outcome-policy.constants';

export interface WriteCustomerPolicyCopyVersionInput {
  readonly terms: CustomerPolicyCopyVersionTermsV1;
  readonly activationEndsAt: Date | null;
}

export interface CreateCustomerPolicyCopyVersionInput extends WriteCustomerPolicyCopyVersionInput {
  readonly copyKey: string;
}

/**
 * The Persian customer-policy copy family — V3.3 Story #42 (`#42a`),
 * ADR-051 §1, `V33-DEC-039` R13, `V33-DEC-042`.
 *
 * ## Text as data, never as code
 *
 * A version is a body of Persian text an administrator authored, versioned,
 * dated and immutable once published. It carries NO number: every hour,
 * minute, percentage, amount or window a customer sees is rendered from the
 * numeric snapshot (`#42b`), so the text can never drift from the terms. No
 * migration, seed, constant or default supplies a body, and no sentence here
 * is or claims to be approved legal text — Legal review of a published version
 * is the external fact `gate:legal` on #42 names.
 *
 * ## The hash is the database's
 *
 * `body_sha256` is computed here for the INSERT and re-checked by
 * `ck_cpcv_body_hash` against `sha256(convert_to(body, 'UTF8'))`, so a stored
 * hash can never disagree with the stored text whichever side wrote it.
 *
 * ## Audit snapshots carry the hash, not the body
 *
 * The body is data an administrator can read through the surface; the audit
 * row records that a version with THIS hash and THIS byte length was drafted,
 * which is enough to prove what was published without copying the text into
 * a second table.
 */
@Injectable()
export class CustomerPolicyCopyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  async listCopies(): Promise<CustomerPolicyCopyEntity[]> {
    return this.dataSource.getRepository(CustomerPolicyCopyEntity).find({ order: { copyKey: 'ASC' } });
  }

  async createCopy(actorUserId: string, copyKey: string, displayName: string, reason: string): Promise<CustomerPolicyCopyEntity> {
    const statedReason = this.requireReason(reason);
    if (!CATALOGUE_KEY_PATTERN.test(copyKey)) {
      throw new CommercialTermsInvalidException(['the key must be 1-64 characters of [A-Za-z0-9_-] starting with a letter']);
    }
    if (typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.trim().length > 120) {
      throw new CommercialTermsInvalidException(['displayName must be 1-120 characters once trimmed']);
    }
    const statedName = displayName.trim();

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerPolicyCopyEntity);
      await translating(
        () => repo.insert({ copyKey, displayName: statedName, createdByUserId: actorUserId, createdByLabel: null }),
        'customer policy copy key',
      );
      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.copyCreated,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.copy,
        targetId: copyKey,
        reason: statedReason,
        after: { copyKey, displayName: statedName },
      });
      const created = await repo.findOne({ where: { copyKey } });
      if (!created) throw new CommercialNotFoundException();
      return created;
    });
  }

  async listVersions(copyKey: string): Promise<CustomerPolicyCopyVersionEntity[]> {
    await this.requireCopy(this.dataSource.manager, copyKey);
    return this.dataSource.getRepository(CustomerPolicyCopyVersionEntity).find({ where: { copyKey }, order: { version: 'ASC' } });
  }

  async getVersion(copyKey: string, version: number): Promise<CustomerPolicyCopyVersionEntity> {
    return this.requireVersion(this.dataSource.manager, copyKey, version);
  }

  async createVersionDraft(
    actorUserId: string,
    input: CreateCustomerPolicyCopyVersionInput,
    reason: string,
  ): Promise<CustomerPolicyCopyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidTerms(input.terms);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requireCopy(manager, input.copyKey, 'share');
      const id = uuidv7();
      const version = await this.insertWithAllocatedVersion(manager, input.copyKey, (next) => ({
        id,
        copyKey: input.copyKey,
        version: next,
        lifecycleState: 'draft' as CatalogueLifecycleState,
        locale: input.terms.locale,
        body: input.terms.body,
        bodySha256: sha256Hex(input.terms.body),
        contractVersion: BOOKING_OUTCOME_CONTRACT_VERSION,
        activationStartsAt: null,
        activationEndsAt: input.activationEndsAt,
        createdByUserId: actorUserId,
        createdByLabel: null,
      }));

      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionDrafted,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.copyVersion,
        targetId: `${input.copyKey}@${version}`,
        reason: statedReason,
        after: this.termsSnapshot(input),
      });

      return this.requireVersion(manager, input.copyKey, version);
    });
  }

  async replaceVersionDraft(
    actorUserId: string,
    copyKey: string,
    version: number,
    input: WriteCustomerPolicyCopyVersionInput,
    reason: string,
  ): Promise<CustomerPolicyCopyVersionEntity> {
    const statedReason = this.requireReason(reason);
    this.requireValidTerms(input.terms);
    this.requireForwardBound(input.activationEndsAt);

    return this.dataSource.transaction(async (manager) => {
      await this.requireCopy(manager, copyKey, 'share');
      const existing = await this.requireVersion(manager, copyKey, version, 'write');
      const before = this.snapshotOf(existing);
      if (existing.lifecycleState !== 'draft') {
        throw new CommercialLifecycleConflictException('a customer policy copy version may only be edited while it is a draft');
      }

      const updated = await translating(
        () =>
          manager.getRepository(CustomerPolicyCopyVersionEntity).update(
            { id: existing.id, lifecycleState: 'draft' },
            {
              locale: input.terms.locale,
              body: input.terms.body,
              bodySha256: sha256Hex(input.terms.body),
              activationEndsAt: input.activationEndsAt,
            },
          ),
        'customer policy copy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the edit landed');
      }

      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionUpdated,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.copyVersion,
        targetId: `${copyKey}@${version}`,
        reason: statedReason,
        before,
        after: this.termsSnapshot(input),
      });

      return this.requireVersion(manager, copyKey, version);
    });
  }

  async publishVersion(actorUserId: string, copyKey: string, version: number, reason: string) {
    return this.transitionVersion(actorUserId, copyKey, version, 'published', reason);
  }

  async retireVersion(actorUserId: string, copyKey: string, version: number, reason: string) {
    return this.transitionVersion(actorUserId, copyKey, version, 'retired', reason);
  }

  async discardVersionDraft(actorUserId: string, copyKey: string, version: number, reason: string): Promise<void> {
    const statedReason = this.requireReason(reason);
    await this.dataSource.transaction(async (manager) => {
      await this.requireCopy(manager, copyKey, 'share');
      const existing = await this.requireVersion(manager, copyKey, version, 'write');
      if (existing.lifecycleState !== 'draft') {
        throw new CommercialLifecycleConflictException('only a draft may be discarded; a published version is permanent');
      }
      const deleted = await translating(
        () => manager.getRepository(CustomerPolicyCopyVersionEntity).delete({ id: existing.id, lifecycleState: 'draft' }),
        'customer policy copy version',
      );
      if (deleted.affected !== 1) {
        throw new CommercialLifecycleConflictException('the version stopped being a draft before the discard landed');
      }
      await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionDiscarded,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.copyVersion,
        targetId: `${copyKey}@${version}`,
        reason: statedReason,
        before: this.snapshotOf(existing),
      });
    });
  }

  // -------------------------------------------------------------------------

  private async transitionVersion(
    actorUserId: string,
    copyKey: string,
    version: number,
    to: CatalogueLifecycleState,
    reason: string,
  ): Promise<CustomerPolicyCopyVersionEntity> {
    const statedReason = this.requireReason(reason);
    const from: CatalogueLifecycleState = to === 'published' ? 'draft' : 'published';
    if (!isPermittedLifecycleTransition(from, to)) {
      throw new CommercialLifecycleConflictException(`the lifecycle does not permit ${from} -> ${to}`);
    }

    return this.dataSource.transaction(async (manager) => {
      await this.requireCopy(manager, copyKey, 'update');
      const existing = await this.requireVersion(manager, copyKey, version, 'write');
      const before = this.snapshotOf(existing);
      if (to === 'published' && existing.activationEndsAt !== null && existing.activationEndsAt.getTime() <= Date.now()) {
        throw new CommercialTermsInvalidException(['activationEndsAt must be later than the publication instant']);
      }

      const patch =
        to === 'published'
          ? { lifecycleState: to, publishedAt: () => 'now()', activationStartsAt: () => 'now()', publishedByUserId: actorUserId, publishedByLabel: null }
          : { lifecycleState: to, retiredAt: () => 'now()', retiredByUserId: actorUserId, retiredByLabel: null };

      const updated = await translating(
        () =>
          manager
            .createQueryBuilder()
            .update(CustomerPolicyCopyVersionEntity)
            .set(patch as never)
            .where('id = :id AND lifecycle_state = :from', { id: existing.id, from })
            .execute(),
        'customer policy copy version',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException(`the version was not ${from} when the transition to ${to} was attempted`);
      }

      await this.audit.record(manager, {
        actorUserId,
        action: to === 'published' ? OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionPublished : OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionRetired,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.copyVersion,
        targetId: `${copyKey}@${version}`,
        reason: statedReason,
        before,
        after: { lifecycleState: to },
      });

      return this.requireVersion(manager, copyKey, version);
    });
  }

  private async insertWithAllocatedVersion(
    manager: EntityManager,
    copyKey: string,
    build: (version: number) => Record<string, unknown>,
  ): Promise<number> {
    const repo = manager.getRepository(CustomerPolicyCopyVersionEntity);
    for (let attempt = 0; attempt < VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
      const highest = await repo.findOne({ where: { copyKey }, order: { version: 'DESC' } });
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
        rethrowTranslated(error, 'customer policy copy version');
      }
    }
    throw new CommercialLifecycleConflictException('the next version number could not be allocated under concurrent drafting');
  }

  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new CommercialReasonRequiredException();
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) throw new CommercialReasonRequiredException();
    return trimmed;
  }

  private requireValidTerms(terms: CustomerPolicyCopyVersionTermsV1): void {
    const problems = validateCustomerPolicyCopyVersionTermsV1(terms);
    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);
  }

  private requireForwardBound(activationEndsAt: Date | null): void {
    if (activationEndsAt === null) return;
    if (Number.isNaN(activationEndsAt.getTime())) throw new CommercialTermsInvalidException(['activationEndsAt must be a valid instant']);
    if (activationEndsAt.getTime() <= Date.now()) throw new CommercialTermsInvalidException(['activationEndsAt must be in the future']);
  }

  private async requireCopy(manager: EntityManager, copyKey: string, lock: 'none' | 'share' | 'update' = 'none') {
    const builder = manager.getRepository(CustomerPolicyCopyEntity).createQueryBuilder('c').where('c.copy_key = :copyKey', { copyKey });
    if (lock === 'update') builder.setLock('pessimistic_write');
    if (lock === 'share') builder.setLock('pessimistic_read');
    const copy = await builder.getOne();
    if (!copy) throw new CommercialNotFoundException();
    return copy;
  }

  private async requireVersion(manager: EntityManager, copyKey: string, version: number, lock: 'none' | 'write' = 'none') {
    const builder = manager
      .getRepository(CustomerPolicyCopyVersionEntity)
      .createQueryBuilder('v')
      .where('v.copy_key = :copyKey AND v.version = :version', { copyKey, version });
    if (lock === 'write') builder.setLock('pessimistic_write');
    const row = await builder.getOne();
    if (!row) throw new CommercialNotFoundException();
    return row;
  }

  private termsSnapshot(input: WriteCustomerPolicyCopyVersionInput): Record<string, string | number | null> {
    return {
      locale: input.terms.locale,
      bodySha256: sha256Hex(input.terms.body),
      bodyBytes: utf8ByteLength(input.terms.body),
      activationEndsAt: input.activationEndsAt ? input.activationEndsAt.toISOString() : null,
    };
  }

  private snapshotOf(row: CustomerPolicyCopyVersionEntity): Record<string, string | number | null> {
    return {
      lifecycleState: row.lifecycleState,
      locale: row.locale,
      bodySha256: row.bodySha256,
      activationStartsAt: row.activationStartsAt ? row.activationStartsAt.toISOString() : null,
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
    };
  }
}

/** The repository's hashing convention (`libs/media`, `libs/workspace-reference`): SHA-256 over UTF-8, hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
