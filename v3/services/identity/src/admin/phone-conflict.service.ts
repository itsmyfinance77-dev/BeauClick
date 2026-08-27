import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { DomainException } from '@beauclick/http';
import { AdminAuditService } from '@beauclick/audit';
import { PhoneConflictEntity } from '../entities/phone-conflict.entity';

export class ConflictNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

/**
 * Phone-conflict review (GAP-20).
 *
 * `identity.phone_conflicts` has existed since Phase 1 and `resolved_at` was
 * **write-never**: the column existed, the rows accumulated, and nothing could
 * ever mark one handled. V2 had the same gap (`AUTH-10`).
 *
 * WHAT RESOLUTION MEANS HERE, stated precisely because it would be easy to
 * assume more: marking a conflict resolved records that a human has looked at
 * it. It does **not** merge accounts, move data, or touch either user's
 * identity in any way -- V3_SECURITY_MODEL.md §1's rule is "never silently
 * merge identities on ambiguity", and an admin button that merged them would
 * be exactly the silent merge the rule forbids, just with a slower trigger.
 * Any actual remediation is a separate, deliberate action that does not exist
 * yet.
 *
 * This is why the service touches only its own table: no direct identity
 * mutation happens outside the services that own it.
 */
@Injectable()
export class PhoneConflictService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PhoneConflictEntity) private readonly conflicts: Repository<PhoneConflictEntity>,
    private readonly audit: AdminAuditService,
  ) {}

  async list(params: {
    page: number;
    limit: number;
    includeResolved: boolean;
  }): Promise<{ items: PhoneConflictEntity[]; total: number }> {
    const [items, total] = await this.conflicts.findAndCount({
      where: params.includeResolved ? {} : { resolvedAt: IsNull() },
      order: { createdAt: 'DESC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
    return { items, total };
  }

  /**
   * Marks one conflict reviewed.
   *
   * IDEMPOTENT, and the idempotency is a compare-and-swap rather than a
   * read-then-write: the UPDATE carries `resolved_at IS NULL` in its own WHERE
   * clause, so two operators clicking simultaneously produce exactly one
   * resolution and exactly one audit row. A read-then-write would produce two
   * of each and a misleading trail.
   */
  async resolve(input: { conflictId: string; actorUserId: string; reason: string }): Promise<PhoneConflictEntity> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager
        .getRepository(PhoneConflictEntity)
        .findOne({ where: { id: input.conflictId } });
      if (!existing) throw new ConflictNotFoundException();

      const result = await manager
        .createQueryBuilder()
        .update(PhoneConflictEntity)
        .set({ resolvedAt: () => 'now()' })
        .where('id = :id AND resolved_at IS NULL', { id: input.conflictId })
        .execute();

      // Already resolved: return the row unchanged and write NO second audit
      // record. Re-recording a no-op as if it were an action is how an audit
      // trail stops being a reliable account of what happened.
      if (result.affected !== 1) {
        return manager.getRepository(PhoneConflictEntity).findOneOrFail({ where: { id: input.conflictId } });
      }

      const after = await manager
        .getRepository(PhoneConflictEntity)
        .findOneOrFail({ where: { id: input.conflictId } });

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: 'identity.phone_conflict_resolved',
        targetType: 'phone_conflict',
        targetId: input.conflictId,
        before: { resolvedAt: null },
        after: { resolvedAt: after.resolvedAt?.toISOString() ?? null },
        reason: input.reason,
      });

      return after;
    });
  }
}
