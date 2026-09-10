import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import { SERVICE_OWNERSHIP_DIRECTORY, ServiceOwnershipDirectoryPort } from './ports';
import {
  AUDIT_TARGET_SERVICE_RESOURCE_REQUIREMENT,
  SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS,
  SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS,
  ServiceResourceRequirementAuditAction,
} from './service-resource-requirement.audit';
import { RequiredResourceKind } from './entities/service-resource-requirement.entity';
import { SetServiceResourceRequirementDto } from './dto/service-resource-requirement.dto';

/**
 * A namespace for this module's advisory locks.
 *
 * PostgreSQL's advisory-lock space is global to the database, so an
 * unqualified key would collide with any future caller that happened to hash
 * the same value. `wishlist.service.ts` claims `0x77697368` ('wish') for its
 * own namespace; this is a second, disjoint one -- `'srrq'` -- claimed
 * explicitly for the same reason.
 */
const SERVICE_RESOURCE_REQUIREMENT_LOCK_NAMESPACE = 0x73_72_72_71 | 0; // 'srrq'

/** What an owner sees back: exactly the one field this story governs. */
export interface ServiceResourceRequirementView {
  readonly requiredKind: RequiredResourceKind | null;
}

interface RequirementRow {
  readonly id: string;
  readonly requiredKind: RequiredResourceKind;
}

/**
 * The owner's configuration of a service's resource requirement -- V3.3 Story
 * #131 (`#127b`), bound by `V33-DEC-035` R5/R6 and ADR-049 section 6.
 *
 * ## Owner-only, re-checked inside the transaction
 *
 * Every mutation is owner-only, resolved live from `businesses.owner_id`
 * inside the mutating transaction -- the same shape `LocationResourceService`
 * and `StaffLocationService` already use. A read never writes.
 *
 * ## One refusal shape
 *
 * A missing, soft-deleted or foreign business; a service that is missing,
 * deleted, or not owned by a professional with an active membership of THIS
 * business -- every non-syntactic cause raises the platform's single
 * `NotFoundOrNotYoursException`. The caller cannot distinguish "no such
 * service" from "not your service" from "that professional has left".
 *
 * ## No lifecycle, no version history
 *
 * Unlike `LocationResourceService.retire`, there is no terminal state here.
 * Clearing (`requiredKind: null`) is a real DELETE, and setting again later is
 * an ordinary fresh creation -- #131's own audit ruled out a version table.
 *
 * ## Concurrency
 *
 * A transaction-scoped advisory lock keyed on `serviceId` serialises
 * concurrent writes to the SAME service's requirement, closing the
 * check-then-insert race an ordinary `SELECT` then `INSERT`/`UPDATE`/`DELETE`
 * would leave open when no row exists yet to take a row lock on -- the same
 * problem, and the same class of fix, `wishlist.service.ts` documents for its
 * own cap enforcement (ADR-033 §8). Locking on `serviceId` alone (not the
 * `(business, service)` pair) is sufficient: `uq_business_staff_active_professional`
 * admits at most one ACTIVE business affiliation per professional at a time,
 * so at most one business can ever pass the ownership check for a given
 * service at a given instant.
 */
@Injectable()
export class ServiceResourceRequirementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    @Inject(SERVICE_OWNERSHIP_DIRECTORY) private readonly serviceOwnership: ServiceOwnershipDirectoryPort,
  ) {}

  /**
   * The service's current requirement, or `{ requiredKind: null }`.
   *
   * **A read never writes.** It runs on the plain manager -- no transaction, no
   * row lock -- and still re-validates that the service belongs to this
   * business, so a caller cannot enumerate an arbitrary `provider.services` id
   * and learn anything about it: an unowned or nonexistent service yields the
   * same `NotFoundOrNotYoursException` a mutation would.
   */
  async read(businessId: string, ownerUserId: string, serviceId: string): Promise<ServiceResourceRequirementView> {
    const manager = this.dataSource.manager;
    await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
    const owns = await this.serviceOwnership.verifyServiceBelongsToBusiness(manager, businessId, serviceId);
    if (!owns) throw new NotFoundOrNotYoursException();

    const existing = await this.findRow(manager, businessId, serviceId);
    return { requiredKind: existing?.requiredKind ?? null };
  }

  /**
   * Sets, changes or clears the requirement.
   *
   * The whole operation is one transaction: live ownership, service
   * ownership, the advisory lock, the write and the audit row all commit
   * together or not at all -- a failed audit rolls the requirement change back
   * with it, and a failed write leaves no audit residue.
   *
   * `requiredKind` unchanged from what is already stored (including
   * `null -> null`, clearing something that was never set) is an idempotent
   * no-op: it writes no row and no audit, exactly as `LocationResourceService.rename`
   * treats an unchanged name.
   */
  async set(
    businessId: string,
    ownerUserId: string,
    serviceId: string,
    dto: SetServiceResourceRequirementDto,
  ): Promise<ServiceResourceRequirementView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);

      // Ownership is proved for BOTH a set and a clear: a caller must not be
      // able to discover, by successfully clearing it, that a requirement
      // exists on a service they do not own.
      const owns = await this.serviceOwnership.verifyServiceBelongsToBusiness(manager, businessId, serviceId);
      if (!owns) throw new NotFoundOrNotYoursException();

      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        SERVICE_RESOURCE_REQUIREMENT_LOCK_NAMESPACE,
        serviceId,
      ]);

      const existing = await this.findRow(manager, businessId, serviceId);
      const before: RequiredResourceKind | null = existing?.requiredKind ?? null;

      if (before === dto.requiredKind) {
        return { requiredKind: before };
      }

      let action: ServiceResourceRequirementAuditAction;
      let reason: string;

      if (dto.requiredKind === null) {
        // `before !== dto.requiredKind` and `dto.requiredKind === null` implies `existing` is present.
        await manager.query(`DELETE FROM business.service_resource_requirements WHERE id = $1`, [existing!.id]);
        action = SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS.cleared;
        reason = SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS.clearedByOwner;
      } else if (existing) {
        await manager.query(
          `UPDATE business.service_resource_requirements SET required_kind = $1, updated_at = now() WHERE id = $2`,
          [dto.requiredKind, existing.id],
        );
        action = SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS.changed;
        reason = SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS.changedByOwner;
      } else {
        const id = uuidv7();
        await manager.query(
          `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, $4)`,
          [id, businessId, serviceId, dto.requiredKind],
        );
        action = SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS.set;
        reason = SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS.setByOwner;
      }

      await this.audit.record(manager, {
        actorUserId: ownerUserId,
        action,
        targetType: AUDIT_TARGET_SERVICE_RESOURCE_REQUIREMENT,
        targetId: existing?.id ?? serviceId,
        before: { requiredKind: before },
        after: { requiredKind: dto.requiredKind },
        reason,
      });

      return { requiredKind: dto.requiredKind };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The live-owner predicate, re-checked inside the mutating transaction.
   *
   * `FOR NO KEY UPDATE` rather than `FOR UPDATE`, which would conflict with
   * the `FOR KEY SHARE` PostgreSQL takes on the parent when a child row
   * referencing it is written -- the same reasoning
   * `LocationResourceService.assertLiveOwnedBusiness` records.
   */
  private async assertLiveOwnedBusiness(manager: EntityManager, businessId: string, ownerUserId: string): Promise<void> {
    const rows: unknown[] = await manager.query(
      `SELECT id FROM business.businesses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [businessId, ownerUserId],
    );
    if (rows.length === 0) throw new NotFoundOrNotYoursException();
  }

  private async findRow(manager: EntityManager, businessId: string, serviceId: string): Promise<RequirementRow | null> {
    const rows: Array<{ id: string; required_kind: RequiredResourceKind }> = await manager.query(
      `SELECT id, required_kind FROM business.service_resource_requirements WHERE business_id = $1 AND service_id = $2`,
      [businessId, serviceId],
    );
    return rows.length === 1 ? { id: rows[0].id, requiredKind: rows[0].required_kind } : null;
  }
}
