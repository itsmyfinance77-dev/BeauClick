import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';
import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity, BusinessStaffRole } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { InviteStaffByPhoneDto } from './dto/staff.dto';
import { StaffMembershipNotFoundException } from './business.errors';
import { STAFF_INVITE_IDENTITY_RESOLVER, StaffInviteIdentityResolverPort } from './ports';
import { returnedRows } from './sql-result';
import { STAFF_INVITE_CLOCK, STAFF_INVITE_MIN_RESPONSE_MS, StaffInviteClock } from './staff-invite.clock';
import {
  AUDIT_TARGET_STAFF_MEMBERSHIP,
  STAFF_AUTHORITY_AUDIT_ACTIONS,
  STAFF_AUTHORITY_AUDIT_REASONS,
} from './staff-authority.audit';

export type BusinessRole = 'owner' | BusinessStaffRole;

/**
 * The staff roster, and the ONE place `business_staff.status` is written.
 *
 * Consent is enforced structurally, not by convention (ADR-023 §2): `invite`
 * always starts a row at `invited`, created by someone who is NOT the
 * invitee, and only `accept` -- called from the INVITEE's own session --
 * can move it to `active`. There is no code path that lets an owner grant
 * themselves a professional's earnings by inviting an id they do not
 * control.
 */
@Injectable()
export class StaffService {
  private readonly auditLog = new AuditLogger('business');

  constructor(
    @InjectRepository(BusinessEntity) private readonly businesses: Repository<BusinessEntity>,
    @InjectRepository(BusinessStaffEntity) private readonly staff: Repository<BusinessStaffEntity>,
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    /**
     * V3.3 #109 (`#44c`). Phone -> eligible account, answered by the composition
     * root because `business` may import neither `identity` nor `provider`
     * (ADR-011). NOT `@Optional()`: a composition that forgets it must fail to
     * boot rather than silently refuse every invitation.
     */
    @Inject(STAFF_INVITE_IDENTITY_RESOLVER) private readonly identities: StaffInviteIdentityResolverPort,
    /** The monotonic seam the response-time floor runs on. See `staff-invite.clock.ts`. */
    @Inject(STAFF_INVITE_CLOCK) private readonly clock: StaffInviteClock,
  ) {}

  /**
   * The session's relationship to this LIVE business, or null if it has none.
   *
   * ## Why `deletedAt: IsNull()` is load-bearing, and why it landed with #107
   *
   * This read had no soft-delete filter. It was invisible while
   * `uq_businesses_owner_id` was unconditional, because one user could then
   * hold at most one row of any kind. V3.3 Story #107 (`#44a`) makes that index
   * partial on `deleted_at IS NULL` -- at which point a user can own a
   * soft-deleted row AND a live row, and `BusinessOwnerResolver`, which reads
   * this method, would grant owner authority over BOTH. The dead business would
   * stay fully reachable through every `@ResolveOwner`-guarded route.
   *
   * So the filter and the partial index are one change (ADR-049 section 2.3).
   * Shipping the index without it would convert a latent `500` into a live
   * authorization defect.
   */
  async roleFor(businessId: string, userId: string): Promise<BusinessRole | null> {
    const business = await this.businesses.findOne({ where: { id: businessId, deletedAt: IsNull() } });
    if (!business) return null;
    if (business.ownerId === userId) return 'owner';

    const membership = await this.staff.findOne({ where: { businessId, userId, status: 'active' } });
    return membership?.role ?? null;
  }

  /**
   * Invite a colleague by phone number -- V3.3 Story #109 (`#44c`).
   *
   * Bound by `V33-DEC-030` D5, ADR-049 sections 4.5-4.7 and `V33-DEC-033` R3/R4.
   *
   * ## It returns nothing, on purpose
   *
   * `void`, rendered by the controller as `202 {}`. Known-eligible, unknown,
   * self-invite, duplicate-in-any-state and ineligible are **externally
   * indistinguishable**: same status, same empty body, and — via the floor below
   * — the same timing class. A response carrying a membership id would be an
   * enumeration oracle, and one carrying it only sometimes would be a louder one.
   * The invitee sees the real invitation, if any, in their own
   * `GET /v1/me/business-staff`, which is the only place a membership id is ever
   * disclosed and the only person entitled to it.
   *
   * ## Nothing is written on any negative path
   *
   * `V33-DEC-033` R3, extending ADR-049 section 4.6 to transient records: no raw
   * phone, no phone hash, no encrypted phone, no lookup token, no pending-invite
   * row, no outbox event, no notification and no audit row is written — durable
   * or queued — for a phone with no account, an ineligible account, a duplicate,
   * a foreign case or the owner inviting themselves. The platform's honest answer
   * to "who tried to invite this number" stays that it does not know.
   *
   * ## The floor applies to every path, including a thrown one
   *
   * The `finally` is load-bearing. Without it an exception would return early and
   * expose the very timing difference the floor exists to remove, and the fake
   * clock proves the floor cannot be bypassed that way. This is a **mitigation**,
   * not constant-time behaviour, and it is never claimed as more.
   */
  async inviteByPhone(businessId: string, inviterUserId: string, dto: InviteStaffByPhoneDto): Promise<void> {
    const startedAt = this.clock.monotonicNowMs();
    try {
      await this.attemptInvitation(businessId, inviterUserId, dto);
    } finally {
      const elapsed = this.clock.monotonicNowMs() - startedAt;
      await this.clock.sleep(STAFF_INVITE_MIN_RESPONSE_MS - elapsed);
    }
  }

  /**
   * Resolution and, only for a known eligible account, the consent-bearing insert
   * — all in one transaction.
   *
   * The membership's `professionalId` comes from the resolver, never from the
   * request (`V33-DEC-033` R2/R4): the inviter neither learns nor asserts it, and
   * a null link simply means a later `practitioner_chat` grant could authorize
   * nothing.
   *
   * `ON CONFLICT DO NOTHING` on `uq_business_staff_membership` is what makes a
   * duplicate in **any** membership state — invited, active, inactive, declined
   * or removed — write nothing and look exactly like every other neutral case,
   * rather than raising the distinguishable `409` this route used to.
   */
  private async attemptInvitation(
    businessId: string,
    inviterUserId: string,
    dto: InviteStaffByPhoneDto,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Live-owner re-check inside the transaction. The route's `@ResolveOwner`
      // already refused a foreign or soft-deleted business, but outside this
      // transaction; a business soft-deleted in between must not gain a member.
      const live: unknown[] = await manager.query(
        `SELECT id FROM business.businesses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
        [businessId, inviterUserId],
      );
      if (live.length === 0) throw new NotFoundOrNotYoursException();

      const identity = await this.identities.resolveInvitableIdentity(manager, dto.phone);

      // Unknown phone, malformed-after-canonicalisation, deleted or otherwise
      // ineligible account. Nothing written, nothing sent.
      if (!identity) return;

      // The owner inviting themselves. Self-invitation is meaningless — the owner
      // already has unconditional control — and it must not be distinguishable
      // from any other neutral outcome, so it writes nothing and returns.
      if (identity.userId === inviterUserId) return;

      /*
       * Already affiliated with ANOTHER business — ADR-049 section 4.6's
       * "foreign" case, and `V33-DEC-033` R3's.
       *
       * Both bind this explicitly: section 4.6 lists "unknown, ineligible,
       * duplicate and foreign" together as **refused resolutions** that are
       * externally indistinguishable, and the story's acceptance criterion is
       * that "nothing is persisted or queued for an absent, ineligible,
       * duplicate, foreign or self case". So this writes nothing and returns,
       * exactly like the three cases around it.
       *
       * `active` is the reading of "affiliated": a membership that is `invited`,
       * `inactive`, `declined` or `removed` is not an affiliation, and treating a
       * years-old declined invitation as one would make a person permanently
       * unhireable. It also matches what the schema already believes —
       * `uq_business_staff_active_professional` admits ONE active professional
       * affiliation at a time, so an invitation issued now to someone active
       * elsewhere could not be accepted anyway.
       */
      const affiliatedElsewhere: unknown[] = await manager.query(
        `SELECT 1 FROM business.business_staff
          WHERE user_id = $1 AND business_id <> $2 AND status = 'active' LIMIT 1`,
        [identity.userId, businessId],
      );
      if (affiliatedElsewhere.length > 0) return;

      const id = uuidv7();
      // `RETURNING id` is what makes the next line true. An INSERT hands back a
      // bare rows array and no count, so testing a positional count here read
      // `undefined` and took the "already a member" branch on EVERY invitation
      // -- creating the membership and then skipping its outbox event, its audit
      // row and its notification. See `sql-result.ts`.
      const inserted = returnedRows(
        await manager.query(
          `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
           VALUES ($1, $2, $3, $4, $5, 'invited', $6)
           ON CONFLICT (business_id, user_id) DO NOTHING
           RETURNING id`,
          [id, businessId, identity.userId, identity.professionalId, dto.role, inviterUserId],
        ),
      );

      // A membership already exists in some state. Unchanged, silent, neutral.
      if (inserted.length !== 1) return;

      await emitEvent(manager, BusinessOutboxEntity, {
        aggregateType: 'business_staff',
        aggregateId: id,
        eventType: 'StaffInvited',
        payload: { staffId: id, businessId, userId: identity.userId, role: dto.role, invitedBy: inviterUserId },
      });

      // One transactional audit row, on this transaction, for the ONE path that
      // actually wrote. The snapshot names no phone, no invitee identity and no
      // professional id — `target_id` is the membership row id, an organisation
      // fact, and the acting owner is `actor_user_id` where actor identity
      // legitimately lives.
      await this.audit.record(manager, {
        actorUserId: inviterUserId,
        action: STAFF_AUTHORITY_AUDIT_ACTIONS.invited,
        targetType: AUDIT_TARGET_STAFF_MEMBERSHIP,
        targetId: id,
        before: null,
        after: { role: dto.role, status: 'invited' },
        reason: STAFF_AUTHORITY_AUDIT_REASONS.invitedByOwner,
      });

      // The operational log carries no phone and no invitee identity either.
      this.auditLog.log({ action: 'business.staff_invited', businessId, staffId: id, role: dto.role });
    });
  }

  /**
   * invited -> active. Callable ONLY by the invited user themselves -- the
   * controller resolves `userId` from the session, never from the route or
   * body, so accepting on someone else's behalf is not an expressible call.
   */
  async accept(staffId: string, userId: string): Promise<BusinessStaffEntity> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(BusinessStaffEntity)
        .set({ status: 'active', respondedAt: new Date() })
        .where('id = :id AND user_id = :userId AND status = :invited', { id: staffId, userId, invited: 'invited' })
        .execute();

      if (result.affected !== 1) throw new StaffMembershipNotFoundException();

      const row = await manager.findOneOrFail(BusinessStaffEntity, { where: { id: staffId } });
      await emitEvent(manager, BusinessOutboxEntity, {
        aggregateType: 'business_staff',
        aggregateId: staffId,
        eventType: 'StaffAccepted',
        payload: { staffId, businessId: row.businessId, userId, role: row.role },
      });

      this.auditLog.log({ action: 'business.staff_accepted', businessId: row.businessId, staffId, userId });
      return row;
    });
  }

  /** invited -> declined. Same caller restriction as accept(). */
  async decline(staffId: string, userId: string): Promise<boolean> {
    const result = await this.staff
      .createQueryBuilder()
      .update(BusinessStaffEntity)
      .set({ status: 'declined', respondedAt: new Date() })
      .where('id = :id AND user_id = :userId AND status = :invited', { id: staffId, userId, invited: 'invited' })
      .execute();
    return result.affected === 1;
  }

  /**
   * active|invited -> inactive. The owner, or the staff member removing
   * themselves -- the controller enforces which via two different resolvers
   * on two different routes, never a shared "actorId === X OR Y" check
   * inside this method, so each permission boundary stays independently
   * testable (V3_SECURITY_MODEL.md's defense-in-depth discipline).
   */
  async deactivate(staffId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(BusinessStaffEntity)
        .set({ status: 'inactive', respondedAt: new Date() })
        .where('id = :id AND status IN (:...active)', { id: staffId, active: ['invited', 'active'] })
        .execute();

      if (result.affected !== 1) return false;

      const row = await manager.findOneOrFail(BusinessStaffEntity, { where: { id: staffId } });
      await emitEvent(manager, BusinessOutboxEntity, {
        aggregateType: 'business_staff',
        aggregateId: staffId,
        eventType: 'StaffDeactivated',
        payload: { staffId, businessId: row.businessId, userId: row.userId },
      });

      this.auditLog.log({ action: 'business.staff_deactivated', businessId: row.businessId, staffId });
      return true;
    });
  }

  async findById(staffId: string): Promise<BusinessStaffEntity | null> {
    return this.staff.findOne({ where: { id: staffId } });
  }

  async listForBusiness(businessId: string): Promise<BusinessStaffEntity[]> {
    return this.staff.find({
      where: { businessId, status: In(['invited', 'active']) },
      order: { createdAt: 'ASC' },
    });
  }

  /** Every membership (any business, any status) belonging to this user -- "my invites and memberships". */
  async listForUser(userId: string): Promise<BusinessStaffEntity[]> {
    return this.staff.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  /** The business a professional is actively affiliated with, or null if independent. Used by financial party resolution (ADR-023 §3). */
  async activeBusinessForProfessional(professionalId: string): Promise<string | null> {
    const row = await this.staff.findOne({ where: { professionalId, status: 'active' } });
    return row?.businessId ?? null;
  }
}
