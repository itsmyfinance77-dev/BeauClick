import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import {
  WORKSPACE_REFERENCE_SECRET,
  deriveLocationReference,
  resolveLocationReference,
} from '@beauclick/workspace-reference';

import {
  AUDIT_TARGET_BUSINESS_LOCATION,
  LOCATION_AUDIT_ACTIONS,
  LOCATION_AUDIT_REASONS,
  LocationAuditAction,
} from './business-location.audit';
import { BusinessLocationLifecycle } from './entities/business-location.entity';
import { CreateLocationDto, RenameLocationDto } from './dto/location.dto';
import { AssignableCity, LOCATION_CITY_CATALOGUE, LocationCityCataloguePort } from './ports';

/**
 * One location, as a caller sees it -- V3.3 Story #108 (`#44b`), ADR-049
 * section 3.5.
 *
 * Exactly four fields. No internal id, no `business_id`, no owner id, no
 * timestamp, no audit field, no city state and no failure cause (#108's issue,
 * and ADR-049 section 7.5). `city` is `null` only if the stored city row was
 * hard-deleted, which no normal path produces.
 */
export interface LocationView {
  readonly locationRef: string;
  readonly name: string;
  readonly city: AssignableCity | null;
  readonly lifecycle: BusinessLocationLifecycle;
}

interface OwnedLocationRow {
  readonly id: string;
  readonly name: string;
  readonly cityId: string;
  readonly lifecycle: BusinessLocationLifecycle;
}

/** The states a transition command may legally start from. `closed` is terminal. */
const TRANSITION_SOURCES: Record<'suspend' | 'reactivate' | 'close', ReadonlyArray<BusinessLocationLifecycle>> = {
  suspend: ['active'],
  reactivate: ['suspended'],
  close: ['active', 'suspended'],
};

const TRANSITION_TARGET: Record<'suspend' | 'reactivate' | 'close', BusinessLocationLifecycle> = {
  suspend: 'suspended',
  reactivate: 'active',
  close: 'closed',
};

const TRANSITION_AUDIT: Record<'suspend' | 'reactivate' | 'close', { action: LocationAuditAction; reason: string }> = {
  suspend: { action: LOCATION_AUDIT_ACTIONS.suspended, reason: LOCATION_AUDIT_REASONS.suspendedByOwner },
  reactivate: { action: LOCATION_AUDIT_ACTIONS.reactivated, reason: LOCATION_AUDIT_REASONS.reactivatedByOwner },
  close: { action: LOCATION_AUDIT_ACTIONS.closed, reason: LOCATION_AUDIT_REASONS.closedByOwner },
};

/**
 * Organisation locations -- V3.3 Story #108 (`#44b`).
 *
 * Bound by `V33-DEC-030` D2 and ADR-049 section 3. Every mutation is owner-only,
 * resolved live from `businesses.owner_id` inside the mutating transaction;
 * staff, manager, membership, classification and traits confer no authority
 * here. A read never writes. Every real create / rename / lifecycle change
 * writes exactly one transactional `admin.admin_audit_log` row on the same
 * `EntityManager`; a no-op and a refusal write none.
 *
 * ## The refusal is one shape
 *
 * Missing / deleted / foreign business, a malformed / foreign / stale
 * `locationRef`, an invalid or unavailable city, and an illegal lifecycle
 * transition all raise the platform's single non-enumerating
 * `NotFoundOrNotYoursException`. Only ordinary syntactic DTO validation is a
 * 400, and that happens in the pipe before this service is reached.
 */
@Injectable()
export class BusinessLocationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    @Inject(LOCATION_CITY_CATALOGUE) private readonly cities: LocationCityCataloguePort,
    /**
     * The SAME secret the workspace reference uses (`V33-DEC-020` -- no second
     * secret). Domain separation is by prefix: `deriveLocationReference` binds
     * `beauclick.location-reference.v1`, so a `locationRef` and a `workspaceRef`
     * can never be confused. Bound globally by `DomainPortsModule`; not
     * `@Optional()`, so a composition that forgets it fails to boot.
     */
    @Inject(WORKSPACE_REFERENCE_SECRET) private readonly referenceSecret: string,
  ) {}

  /**
   * The live owned business's locations, deterministically ordered.
   *
   * **A read never writes.** It runs on the plain manager -- no transaction, no
   * row lock, no lazy initialisation -- exactly as `BusinessClassificationService.read`
   * does, and relies on the `@ResolveOwner` guard that every caller passes
   * through for the live-ownership refusal. The join to `businesses` still scopes
   * every row to the live owner as defence in depth.
   *
   * Ordered by the uuidv7 primary key, which is creation-ordered, so the
   * sequence is stable without a timestamp column and a client never depends on
   * physical row order. The collection is naturally bounded -- one organisation
   * per owner for V3.3/MVP (`V33-DEC-030` D3) -- so there is no cursor parameter
   * to accept or reject.
   */
  async list(businessId: string, ownerUserId: string): Promise<LocationView[]> {
    const manager = this.dataSource.manager;
    const rows = await this.ownedLocations(manager, businessId, ownerUserId, false);
    const cityById = await this.cities.describeCities(manager, [...new Set(rows.map((row) => row.cityId))]);
    return rows.map((row) => this.view(ownerUserId, businessId, row, cityById.get(row.cityId) ?? null));
  }

  async create(businessId: string, ownerUserId: string, dto: CreateLocationDto): Promise<LocationView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);

      const city = await this.cities.lookupAssignableCity(manager, dto.cityId);
      if (!city) throw new NotFoundOrNotYoursException();

      const id = uuidv7();
      await manager.query(
        `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, $3, $4, 'active')`,
        [id, businessId, dto.name, dto.cityId],
      );

      await this.recordAudit(manager, ownerUserId, id, LOCATION_AUDIT_ACTIONS.created, LOCATION_AUDIT_REASONS.createdByOwner, {
        before: null,
        after: { lifecycle: 'active' },
      });

      return this.view(ownerUserId, businessId, { id, name: dto.name, cityId: dto.cityId, lifecycle: 'active' }, city);
    });
  }

  async rename(businessId: string, ownerUserId: string, locationRef: string, dto: RenameLocationDto): Promise<LocationView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
      const location = await this.resolveOwnedLocationForUpdate(manager, businessId, ownerUserId, locationRef);

      // Rename only while not closed (ADR-049 section 3). A closed location
      // refuses with the same shape as a stale ref.
      if (location.lifecycle === 'closed') throw new NotFoundOrNotYoursException();

      const city = (await this.cities.describeCities(manager, [location.cityId])).get(location.cityId) ?? null;

      // Idempotent: the name it already has churns no row and writes no audit.
      if (location.name === dto.name) {
        return this.view(ownerUserId, businessId, location, city);
      }

      // Compare-and-swap on the observed lifecycle: a concurrent close cannot be
      // lost, because the UPDATE that would race it no longer matches.
      const result = await manager.query(
        `UPDATE business.locations SET name = $1, updated_at = now() WHERE id = $2 AND lifecycle = $3`,
        [dto.name, location.id, location.lifecycle],
      );
      if (rowCount(result) !== 1) throw new NotFoundOrNotYoursException();

      await this.recordAudit(manager, ownerUserId, location.id, LOCATION_AUDIT_ACTIONS.renamed, LOCATION_AUDIT_REASONS.renamedByOwner, {
        before: { lifecycle: location.lifecycle },
        after: { lifecycle: location.lifecycle },
      });

      return this.view(ownerUserId, businessId, { ...location, name: dto.name }, city);
    });
  }

  suspend(businessId: string, ownerUserId: string, locationRef: string): Promise<LocationView> {
    return this.transition(businessId, ownerUserId, locationRef, 'suspend');
  }

  reactivate(businessId: string, ownerUserId: string, locationRef: string): Promise<LocationView> {
    return this.transition(businessId, ownerUserId, locationRef, 'reactivate');
  }

  close(businessId: string, ownerUserId: string, locationRef: string): Promise<LocationView> {
    return this.transition(businessId, ownerUserId, locationRef, 'close');
  }

  private async transition(
    businessId: string,
    ownerUserId: string,
    locationRef: string,
    kind: 'suspend' | 'reactivate' | 'close',
  ): Promise<LocationView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
      const location = await this.resolveOwnedLocationForUpdate(manager, businessId, ownerUserId, locationRef);
      const city = (await this.cities.describeCities(manager, [location.cityId])).get(location.cityId) ?? null;

      const target = TRANSITION_TARGET[kind];

      // Already in the target state: unchanged success, no row churn, no audit.
      if (location.lifecycle === target) {
        return this.view(ownerUserId, businessId, location, city);
      }

      // Not a legal source for this transition (includes every attempt to leave
      // `closed`): the same refusal as a stale ref.
      if (!TRANSITION_SOURCES[kind].includes(location.lifecycle)) {
        throw new NotFoundOrNotYoursException();
      }

      const result = await manager.query(
        `UPDATE business.locations SET lifecycle = $1, updated_at = now() WHERE id = $2 AND lifecycle = $3`,
        [target, location.id, location.lifecycle],
      );
      if (rowCount(result) !== 1) throw new NotFoundOrNotYoursException();

      const { action, reason } = TRANSITION_AUDIT[kind];
      await this.recordAudit(manager, ownerUserId, location.id, action, reason, {
        before: { lifecycle: location.lifecycle },
        after: { lifecycle: target },
      });

      return this.view(ownerUserId, businessId, { ...location, lifecycle: target }, city);
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The live-owner predicate, re-checked inside the mutating transaction.
   *
   * The `@ResolveOwner` guard already resolved ownership, but outside this
   * transaction: a business soft-deleted between the guard and here must not be
   * mutated. `FOR NO KEY UPDATE` (not `FOR UPDATE`, which would conflict with the
   * `FOR KEY SHARE` PostgreSQL takes on the parent when a child location row is
   * inserted) serialises this against a concurrent business change.
   */
  private async assertLiveOwnedBusiness(manager: EntityManager, businessId: string, ownerUserId: string): Promise<void> {
    const rows: unknown[] = await manager.query(
      `SELECT id FROM business.businesses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [businessId, ownerUserId],
    );
    if (rows.length === 0) throw new NotFoundOrNotYoursException();
  }

  /**
   * The caller's live-owned locations for this business.
   *
   * The join to `business.businesses` re-asserts live ownership per row, so a
   * `locationRef` never authorises on its own -- it is only ever compared
   * against locations this query already returned. `forUpdate` takes
   * `FOR NO KEY UPDATE` on the location rows so a resolved location cannot change
   * lifecycle between the read and the compare-and-swap.
   */
  private async ownedLocations(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    forUpdate: boolean,
  ): Promise<OwnedLocationRow[]> {
    const rows: Array<{ id: string; name: string; city_id: string; lifecycle: BusinessLocationLifecycle }> =
      await manager.query(
        `SELECT l.id, l.name, l.city_id, l.lifecycle
           FROM business.locations l
           JOIN business.businesses b ON b.id = l.business_id
          WHERE l.business_id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL
          ORDER BY l.id${forUpdate ? ' FOR NO KEY UPDATE OF l' : ''}`,
        [businessId, ownerUserId],
      );
    return rows.map((row) => ({ id: row.id, name: row.name, cityId: row.city_id, lifecycle: row.lifecycle }));
  }

  private async resolveOwnedLocationForUpdate(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    locationRef: string,
  ): Promise<OwnedLocationRow> {
    const owned = await this.ownedLocations(manager, businessId, ownerUserId, true);
    const match = resolveLocationReference(
      this.referenceSecret,
      ownerUserId,
      owned.map((row) => ({ businessId, locationId: row.id })),
      locationRef,
    );
    if (!match) throw new NotFoundOrNotYoursException();
    return owned.find((row) => row.id === match.locationId)!;
  }

  private view(
    ownerUserId: string,
    businessId: string,
    row: OwnedLocationRow,
    city: AssignableCity | null,
  ): LocationView {
    return {
      locationRef: deriveLocationReference(this.referenceSecret, ownerUserId, businessId, row.id),
      name: row.name,
      city: city ? { id: city.id, name: city.name } : null,
      lifecycle: row.lifecycle,
    };
  }

  private async recordAudit(
    manager: EntityManager,
    actorUserId: string,
    locationId: string,
    action: LocationAuditAction,
    reason: string,
    states: { before: { lifecycle: BusinessLocationLifecycle } | null; after: { lifecycle: BusinessLocationLifecycle } },
  ): Promise<void> {
    await this.audit.record(manager, {
      actorUserId,
      action,
      targetType: AUDIT_TARGET_BUSINESS_LOCATION,
      targetId: locationId,
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
