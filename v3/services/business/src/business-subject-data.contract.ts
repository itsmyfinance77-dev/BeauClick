import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { returnedRows } from './sql-result';

/**
 * business' subject-data contract.
 *
 * **A BUSINESS DECISION IS OPEN HERE AND THIS CODE DOES NOT SILENTLY SETTLE
 * IT.** What should happen to a salon when its owner deletes their personal
 * account? Three answers are defensible -- the business closes with them, the
 * business survives with an unassigned owner, or ownership transfers to a
 * manager on the staff. Each has real consequences for the staff who work
 * there and the customers holding bookings.
 *
 * Until that is decided, this contract takes the option that destroys nothing
 * and misrepresents nothing: the business row is RETAINED, and the erased
 * owner's staff membership is set to `removed` so they lose their access. A
 * business is a commercial entity with its own name, its own bookings, and its
 * own staff, and inferring "delete the salon" from "delete my account" would
 * be inventing product policy with other people's livelihoods attached.
 *
 * Recorded in `V3.1_PHASE_E_IMPLEMENTATION.md` §business decisions.
 */
@Injectable()
export class BusinessSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'business';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'business.businesses',
      disposition: 'retained',
      reason:
        'A commercial entity with its own staff and bookings. What happens to a business whose owner erases their account is an open product decision (see the class note); retaining destroys nothing while it is open.',
    },
    { table: 'business.business_staff', disposition: 'subject_data' },
    { table: 'business.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
    // V3.3 Story #107 (`#44a`), ADR-049 section 7.2. Both are RETAINED, and the
    // reason is the same in substance for each: they describe a COMMERCIAL
    // ENTITY, not a person. There is no `user_id`, no `*_by`, no `*_user_id`,
    // no phone and no email on either table -- the actor who set a
    // classification lives in `admin.admin_audit_log` and nowhere else -- so
    // erasing an individual has nothing to erase here, and destroying the rows
    // would delete a salon's own description of itself for no privacy gain.
    //
    // They are deliberately NOT in the export document either: an export tells a
    // SUBJECT what the platform holds about THEM, and "this salon is a salon" is
    // not that. The business rows a user owns are already exported by
    // `owned_businesses` below.
    {
      table: 'business.business_verticals',
      disposition: 'retained',
      reason:
        'The commercial vertical a business is classified as. A property of the organisation, naming no person and carrying no identity column, so it survives the erasure of any individual exactly as the business row itself does.',
    },
    {
      table: 'business.business_traits',
      disposition: 'retained',
      reason:
        'How a business operates (multi-location, mobile). A property of the organisation, naming no person and carrying no identity column, so it survives the erasure of any individual exactly as the business row itself does.',
    },
    // V3.3 Story #108 (`#44b`), ADR-049 section 7.2. `retained`, for the same
    // substance as the two #107 tables above: a location is a property of a
    // COMMERCIAL ENTITY, not of a person. It carries no `user_id`, no `*_by`, no
    // `*_user_id`, no phone and no email -- the actor who created, renamed or
    // closed a location lives in `admin.admin_audit_log` and nowhere else -- so
    // erasing an individual has nothing to erase here, and destroying the rows
    // would delete a business's own description of its branches for no privacy
    // gain. `no_subject_data` is the only other disposition ADR-049 section 7.2
    // permits for this table; `retained` is chosen for consistency with the
    // business rows it hangs off, all of which are `retained` while owner-erasure
    // succession stays an open product decision (see the class note).
    //
    // Deliberately NOT in the export document: an export tells a SUBJECT what
    // the platform holds about THEM, and "this organisation has a branch in
    // Tehran" is not that. The business rows a user owns are already exported by
    // `owned_businesses` below.
    {
      table: 'business.locations',
      disposition: 'retained',
      reason:
        'A named branch of a business organisation -- its name, opaque city reference and active|suspended|closed lifecycle. A property of the organisation, naming no person and carrying no identity column, so it survives the erasure of any individual exactly as the business row it hangs off does.',
    },
    // V3.3 Story #109 (`#44c`), ADR-049 section 7.2: "Membership-anchored scoped
    // grants -> `subject_data`. A grant names a person's authority." Unlike the
    // organisation-fact tables above, this one is about a PERSON: it records what
    // a named member of staff was allowed to do. `subject_data` needs no reason —
    // it is the default obligation, not an exemption from one.
    //
    // `granted_by_user_id` and `revoked_by_user_id` end in `_user_id`, so ADR-027's
    // coverage cross-check (`isSubjectColumn`) recognises them: a future
    // `no_subject_data` claim on this table would be refused at boot rather than
    // by someone noticing. `membership_id` deliberately does not match the
    // heuristic — it is a `business` row id, not a person.
    { table: 'business.staff_role_grants', disposition: 'subject_data' },
    // V3.3 Story #110 (`#110a`), `V33-DEC-034` R7 and ADR-049 section 7.2.
    // `retained`, for exactly the reason `business.locations` above is: a room, a
    // device or a styling station is a property of the ORGANISATION. It names no
    // person, carries no identity column, and survives the erasure of any
    // individual precisely as the location it hangs off does.
    //
    // No actor or user column was added to this table to satisfy ADR-027's
    // heuristic -- adding one to make the check happy would invent the very
    // subject data the claim says is absent. Actor identity for every resource
    // mutation lives in `admin.admin_audit_log` and nowhere else.
    {
      table: 'business.location_resources',
      disposition: 'retained',
      reason:
        "A bookable resource of a business branch -- its name, its room|device|station kind and its active|retired lifecycle. A property of the organisation's premises, naming no person and carrying no identity column, so it survives the erasure of any individual exactly as the location row it hangs off does.",
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const owned = await manager.getRepository(BusinessEntity).find({ where: { ownerId: userId } });
    const memberships = await manager.getRepository(BusinessStaffEntity).find({ where: { userId } });

    return [
      {
        key: 'owned_businesses',
        description: 'کسب‌وکارهایی که مالک آن هستید',
        rows: owned.map((b) => ({
          id: b.id,
          displayName: b.displayName,
          bio: b.bio,
          cityId: b.cityId,
          verificationStatus: b.verificationStatus,
          createdAt: b.createdAt,
        })),
      },
      {
        key: 'staff_memberships',
        description: 'عضویت شما در کسب‌وکارها',
        // `invitedBy` is deliberately absent: it identifies a different
        // person, and who invited you is their action, not your data.
        rows: memberships.map((s) => ({
          id: s.id,
          businessId: s.businessId,
          role: s.role,
          status: s.status,
          respondedAt: s.respondedAt,
          createdAt: s.createdAt,
        })),
      },
      {
        // V3.3 Story #109 (`#44c`), ADR-049 section 7.2: "Export must return the
        // grantee's own grants and must NOT disclose the granting actor's
        // identity."
        //
        // `granted_by_user_id` and `revoked_by_user_id` are therefore absent, for
        // the same reason `invitedBy` is absent above: who granted you an
        // authority is THEIR action, not your data. Revoked grants are included —
        // "you held this and it ended" is as much the subject's own history as
        // "you hold this".
        key: 'staff_role_grants',
        description: 'دسترسی‌های اختصاصی شما در کسب‌وکارها',
        rows: await manager.query(
          `SELECT g.role, g.business_id AS "businessId", g.granted_at AS "grantedAt", g.revoked_at AS "revokedAt"
             FROM business.staff_role_grants g
             JOIN business.business_staff s ON s.id = g.membership_id
            WHERE s.user_id = $1
            ORDER BY g.granted_at, g.id`,
          [userId],
        ),
      },
    ];
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    /*
     * V3.3 Story #109 (`#44c`), ADR-049 section 7.2: "erasure must revoke live
     * grants in the SAME transaction as the membership change."
     *
     * `manager` is `PrivacyService.executeErasure`'s single transaction over the
     * main DataSource, shared by every module's contract — so the two statements
     * below are atomic by construction, not by a second mechanism. A failure
     * anywhere in that transaction leaves the subject fully intact: no state
     * exists where the authority is gone but the membership still says `active`,
     * or the reverse.
     *
     * Grants are revoked BEFORE the membership is marked `removed`, which is the
     * safe order rather than an arbitrary one: at every instant inside the
     * transaction the visible state is at least as restrictive as the previous
     * one, so a concurrent authorizer read can never observe a live grant on a
     * membership that has already lost its `active` status.
     *
     * `revoked_by_user_id` is deliberately left NULL: erasure has no human actor,
     * and fabricating one would put a person's name on something nobody did.
     * `ck_staff_role_grants_revocation` permits exactly that shape.
     */
    const revoked = returnedRows(
      await manager.query(
        `UPDATE business.staff_role_grants g
            SET revoked_at = now()
          FROM business.business_staff s
          WHERE s.id = g.membership_id AND s.user_id = $1 AND g.revoked_at IS NULL
          RETURNING g.id`,
        [userId],
      ),
    );

    // Access ends. The row survives so the business's own history of who
    // worked there stays intact -- and it now names an anonymous id.
    const removed = returnedRows(
      await manager.query(
        `UPDATE business.business_staff
            SET status = 'removed', updated_at = now()
          WHERE user_id = $1 AND status <> 'removed'
          RETURNING id`,
        [userId],
      ),
    );

    return {
      moduleKey: this.moduleKey,
      // Truthful counts: memberships moved to `removed` plus grants revoked.
      // Both are anonymisations in the platform's sense -- the row survives, the
      // subject's link to an active authority does not.
      anonymized: removed.length + revoked.length,
      deleted: 0,
      retained: [
        {
          table: 'business.businesses',
          reason: 'a commercial entity with its own staff and bookings; ownership succession is an open product decision',
        },
        {
          table: 'business.business_verticals',
          reason: 'the commercial classification of a business, not a fact about any person',
        },
        {
          table: 'business.business_traits',
          reason: 'how a business operates, not a fact about any person',
        },
        {
          table: 'business.locations',
          reason: 'named branches of a business, not a fact about any person',
        },
        {
          table: 'business.location_resources',
          reason: 'the rooms, devices and stations of a branch, not a fact about any person',
        },
      ],
    };
  }
}
