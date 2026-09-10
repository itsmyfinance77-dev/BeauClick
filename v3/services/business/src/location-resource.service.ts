import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import {
  WORKSPACE_REFERENCE_SECRET,
  deriveResourceReference,
  resolveLocationReference,
  resolveResourceReference,
} from '@beauclick/workspace-reference';

import { RESOURCE_ASSIGNMENT_DIRECTORY, ResourceAssignmentDirectoryPort } from './ports';
import {
  AUDIT_TARGET_LOCATION_RESOURCE,
  LOCATION_RESOURCE_AUDIT_ACTIONS,
  LOCATION_RESOURCE_AUDIT_REASONS,
  LocationResourceAuditAction,
} from './location-resource.audit';
import { LocationResourceKind, LocationResourceLifecycle } from './entities/location-resource.entity';
import { CreateLocationResourceDto, RenameLocationResourceDto } from './dto/location-resource.dto';

/**
 * One resource, as a caller sees it -- V3.3 Story #110 (`#110a`).
 *
 * Exactly four fields. No internal id, no `location_id`, no `business_id`, no
 * owner or actor id, no timestamp, no audit field and no failure cause -- the
 * same shape discipline `LocationView` follows (#108's issue, ADR-049 section
 * 7.5). Timestamps are omitted because the location catalogue omits them, and
 * `V33-DEC-034` R7 admits them only if consistent with that contract.
 *
 * **No booking or occupancy field of any kind** (`V33-DEC-034` R6): whether a
 * resource is busy is not a property this story can compute and not one any
 * caller may learn here.
 */
export interface LocationResourceView {
  readonly resourceRef: string;
  readonly name: string;
  readonly kind: LocationResourceKind;
  readonly lifecycle: LocationResourceLifecycle;
}

interface OwnedResourceRow {
  readonly id: string;
  readonly name: string;
  readonly kind: LocationResourceKind;
  readonly lifecycle: LocationResourceLifecycle;
}

/** The one live-owned location a `locationRef` names, resolved before any resource work. */
interface OwnedLocation {
  readonly id: string;
}

/**
 * The location resource catalogue -- V3.3 Story #110 (`#110a`).
 *
 * Bound by `V33-DEC-034` and ADR-049 sections 3 and 6. Every mutation is
 * owner-only, resolved live from `businesses.owner_id` inside the mutating
 * transaction; staff, manager, membership, classification, traits and every
 * scoped grant confer no authority here. A read never writes. Every real create /
 * rename / retire writes exactly one transactional `admin.admin_audit_log` row on
 * the same `EntityManager`; a no-op and a refusal write none.
 *
 * ## The refusal is one shape
 *
 * Missing / deleted / foreign business; a malformed, foreign or stale
 * `locationRef` or `resourceRef`; a closed location; a retired resource; and a
 * rename or retire that races a concurrent retirement -- all raise the platform's
 * single non-enumerating `NotFoundOrNotYoursException`. Only ordinary syntactic
 * DTO validation is a 400, and that happens in the pipe before this service is
 * reached. A caller cannot distinguish "no such resource" from "not your
 * business" from "already retired".
 *
 * ## `retired` is terminal, and the database says so
 *
 * There is no restore method here because no restore is authorized. The service
 * also never issues one: `tg_location_resources_lifecycle` refuses
 * `retired -> active`, every identity change and every DELETE, so the terminality
 * survives a future caller who forgets.
 */
@Injectable()
export class LocationResourceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    /**
     * The SAME secret the workspace and location references use (`V33-DEC-020` --
     * no second secret). Domain separation is by prefix:
     * `deriveResourceReference` binds `beauclick.resource-reference.v1`, so a
     * `resourceRef`, a `locationRef` and a `workspaceRef` can never be confused.
     * Bound globally by `DomainPortsModule`; not `@Optional()`, so a composition
     * that forgets it fails to boot.
     */
    @Inject(WORKSPACE_REFERENCE_SECRET) private readonly referenceSecret: string,
    /**
     * V3.3 #128 (`#110b`), ADR-049 §6.6. **Mandatory**, deliberately without
     * `@Optional()` -- the same reasoning `referenceSecret` above carries: a
     * composition missing the binding must fail to construct rather than
     * silently letting `retire()` succeed on a resource a customer's
     * upcoming appointment still depends on.
     */
    @Inject(RESOURCE_ASSIGNMENT_DIRECTORY) private readonly resourceAssignments: ResourceAssignmentDirectoryPort,
  ) {}

  /**
   * The resources of one live-owned location, deterministically ordered.
   *
   * **A read never writes.** It runs on the plain manager -- no transaction, no
   * row lock, no lazy initialisation -- exactly as `BusinessLocationService.list`
   * does, and relies on the `@ResolveOwner` guard every caller passes through for
   * the live-ownership refusal. The join to `businesses` still scopes every row
   * to the live owner as defence in depth.
   *
   * **Two queries total, regardless of how many resources exist**: one to
   * enumerate the caller's live-owned locations (which is also what resolves the
   * `locationRef`), and one to read that location's resources. There is no
   * per-row lookup and no per-row reference query -- `resourceRef` is computed in
   * process from material already in hand.
   *
   * Ordered by the uuidv7 primary key, which is creation-ordered, so the sequence
   * is stable without depending on physical row order. Retired resources are
   * included: an owner needs to see that a device they retired is gone rather
   * than have it vanish silently, and the lifecycle field says which is which.
   */
  async list(businessId: string, ownerUserId: string, locationRef: string): Promise<LocationResourceView[]> {
    const manager = this.dataSource.manager;
    const location = await this.resolveOwnedLocation(manager, businessId, ownerUserId, locationRef, false);
    const rows = await this.resourcesOf(manager, location.id, false);
    return rows.map((row) => this.view(ownerUserId, businessId, location.id, row));
  }

  async create(
    businessId: string,
    ownerUserId: string,
    locationRef: string,
    dto: CreateLocationResourceDto,
  ): Promise<LocationResourceView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
      const location = await this.resolveOwnedLocation(manager, businessId, ownerUserId, locationRef, true);

      const id = uuidv7();
      await manager.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, location.id, businessId, dto.kind, dto.name],
      );

      await this.recordAudit(
        manager,
        ownerUserId,
        id,
        LOCATION_RESOURCE_AUDIT_ACTIONS.created,
        LOCATION_RESOURCE_AUDIT_REASONS.createdByOwner,
        { before: null, after: { lifecycle: 'active' } },
      );

      return this.view(ownerUserId, businessId, location.id, {
        id,
        name: dto.name,
        kind: dto.kind,
        lifecycle: 'active',
      });
    });
  }

  async rename(
    businessId: string,
    ownerUserId: string,
    locationRef: string,
    resourceRef: string,
    dto: RenameLocationResourceDto,
  ): Promise<LocationResourceView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
      const location = await this.resolveOwnedLocation(manager, businessId, ownerUserId, locationRef, true);
      const resource = await this.resolveOwnedResourceForUpdate(manager, businessId, ownerUserId, location.id, resourceRef);

      // A retired resource is not renameable. Terminal means terminal, and the
      // refusal is the same shape as a stale ref. The trigger would refuse this
      // too; refusing here keeps it a 404 rather than a 500.
      if (resource.lifecycle === 'retired') throw new NotFoundOrNotYoursException();

      // Idempotent: the name it already has churns no row and writes no audit.
      if (resource.name === dto.name) {
        return this.view(ownerUserId, businessId, location.id, resource);
      }

      // Compare-and-swap on the observed lifecycle: a concurrent retire cannot be
      // lost, because the UPDATE that would race it no longer matches. This is
      // what closes the read-before-write window that would otherwise allow a
      // rename to land after retirement.
      const result = await manager.query(
        `UPDATE business.location_resources SET name = $1, updated_at = now()
          WHERE id = $2 AND lifecycle = $3`,
        [dto.name, resource.id, resource.lifecycle],
      );
      if (rowCount(result) !== 1) throw new NotFoundOrNotYoursException();

      await this.recordAudit(
        manager,
        ownerUserId,
        resource.id,
        LOCATION_RESOURCE_AUDIT_ACTIONS.renamed,
        LOCATION_RESOURCE_AUDIT_REASONS.renamedByOwner,
        { before: { lifecycle: resource.lifecycle }, after: { lifecycle: resource.lifecycle } },
      );

      return this.view(ownerUserId, businessId, location.id, { ...resource, name: dto.name });
    });
  }

  /**
   * `active -> retired`, one-way.
   *
   * A second retire of an already-retired resource is the **same refusal** as a
   * stale reference, not a distinguishable "already retired" outcome: telling the
   * two apart would be a cause the closed refusal vocabulary does not have, and
   * `V33-DEC-034` R6's non-enumeration requirement is exactly about not inventing
   * one. It therefore cannot create a duplicate effect -- no second row, no
   * second audit fact, no second timestamp.
   */
  async retire(
    businessId: string,
    ownerUserId: string,
    locationRef: string,
    resourceRef: string,
  ): Promise<LocationResourceView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
      const location = await this.resolveOwnedLocation(manager, businessId, ownerUserId, locationRef, true);
      const resource = await this.resolveOwnedResourceForUpdate(manager, businessId, ownerUserId, location.id, resourceRef);

      if (resource.lifecycle === 'retired') throw new NotFoundOrNotYoursException();

      // ADR-049 §6.6: blocked, never cascaded. Locks `resource.id` against a
      // concurrent assignment-creation for this exact resource (see
      // `RESOURCE_ASSIGNMENT_DIRECTORY`'s own documentation), then checks for
      // any still-relevant booking. The SAME non-enumerating refusal as
      // every other cause in this method -- an owner cannot tell "a future
      // appointment needs this" apart from "already retired" or "no such
      // resource".
      if (await this.resourceAssignments.hasFutureAssignment(manager, [resource.id])) {
        throw new NotFoundOrNotYoursException();
      }

      const result = await manager.query(
        `UPDATE business.location_resources SET lifecycle = 'retired', updated_at = now()
          WHERE id = $1 AND lifecycle = 'active'`,
        [resource.id],
      );
      if (rowCount(result) !== 1) throw new NotFoundOrNotYoursException();

      await this.recordAudit(
        manager,
        ownerUserId,
        resource.id,
        LOCATION_RESOURCE_AUDIT_ACTIONS.retired,
        LOCATION_RESOURCE_AUDIT_REASONS.retiredByOwner,
        { before: { lifecycle: 'active' }, after: { lifecycle: 'retired' } },
      );

      return this.view(ownerUserId, businessId, location.id, { ...resource, lifecycle: 'retired' });
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The live-owner predicate, re-checked inside the mutating transaction.
   *
   * The `@ResolveOwner` guard already resolved ownership, but outside this
   * transaction: a business soft-deleted between the guard and here must not be
   * mutated. `FOR NO KEY UPDATE` (not `FOR UPDATE`, which would conflict with the
   * `FOR KEY SHARE` PostgreSQL takes on the parent when a child row is inserted)
   * serialises this against a concurrent business change.
   */
  private async assertLiveOwnedBusiness(manager: EntityManager, businessId: string, ownerUserId: string): Promise<void> {
    const rows: unknown[] = await manager.query(
      `SELECT id FROM business.businesses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [businessId, ownerUserId],
    );
    if (rows.length === 0) throw new NotFoundOrNotYoursException();
  }

  /**
   * The live-owned location a `locationRef` names.
   *
   * Enumerates the caller's live-owned locations and constant-time compares, the
   * same construction `BusinessLocationService` uses -- there is no query BY
   * `locationRef`, so a reference never authorises on its own.
   *
   * A `closed` location is excluded: its catalogue is not editable and not
   * listable, and the refusal is indistinguishable from a stale reference.
   */
  private async resolveOwnedLocation(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    locationRef: string,
    forUpdate: boolean,
  ): Promise<OwnedLocation> {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT l.id
         FROM business.locations l
         JOIN business.businesses b ON b.id = l.business_id
        WHERE l.business_id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL AND l.lifecycle <> 'closed'
        ORDER BY l.id${forUpdate ? ' FOR NO KEY UPDATE OF l' : ''}`,
      [businessId, ownerUserId],
    );

    const match = resolveLocationReference(
      this.referenceSecret,
      ownerUserId,
      rows.map((row) => ({ businessId, locationId: row.id })),
      locationRef,
    );
    if (!match) throw new NotFoundOrNotYoursException();
    return { id: match.locationId };
  }

  /**
   * One location's resources, deterministically ordered.
   *
   * `forUpdate` takes `FOR NO KEY UPDATE` on the resource rows so a resolved
   * resource cannot change lifecycle between the read and the compare-and-swap.
   */
  private async resourcesOf(
    manager: EntityManager,
    locationId: string,
    forUpdate: boolean,
  ): Promise<OwnedResourceRow[]> {
    const rows: Array<{ id: string; name: string; kind: LocationResourceKind; lifecycle: LocationResourceLifecycle }> =
      await manager.query(
        `SELECT r.id, r.name, r.kind, r.lifecycle
           FROM business.location_resources r
          WHERE r.location_id = $1
          ORDER BY r.id${forUpdate ? ' FOR NO KEY UPDATE OF r' : ''}`,
        [locationId],
      );
    return rows;
  }

  private async resolveOwnedResourceForUpdate(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    locationId: string,
    resourceRef: string,
  ): Promise<OwnedResourceRow> {
    const owned = await this.resourcesOf(manager, locationId, true);
    const match = resolveResourceReference(
      this.referenceSecret,
      ownerUserId,
      owned.map((row) => ({ businessId, locationId, resourceId: row.id })),
      resourceRef,
    );
    if (!match) throw new NotFoundOrNotYoursException();
    return owned.find((row) => row.id === match.resourceId)!;
  }

  private view(
    ownerUserId: string,
    businessId: string,
    locationId: string,
    row: OwnedResourceRow,
  ): LocationResourceView {
    return {
      resourceRef: deriveResourceReference(this.referenceSecret, ownerUserId, businessId, locationId, row.id),
      name: row.name,
      kind: row.kind,
      lifecycle: row.lifecycle,
    };
  }

  private async recordAudit(
    manager: EntityManager,
    actorUserId: string,
    resourceId: string,
    action: LocationResourceAuditAction,
    reason: string,
    states: {
      before: { lifecycle: LocationResourceLifecycle } | null;
      after: { lifecycle: LocationResourceLifecycle };
    },
  ): Promise<void> {
    await this.audit.record(manager, {
      actorUserId,
      action,
      targetType: AUDIT_TARGET_LOCATION_RESOURCE,
      targetId: resourceId,
      before: states.before,
      after: states.after,
      reason,
    });
  }
}

/** TypeORM's raw query path returns `[rows, rowCount]` for INSERT/UPDATE/DELETE. */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
