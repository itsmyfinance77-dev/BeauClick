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
    ];
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    // Access ends. The row survives so the business's own history of who
    // worked there stays intact -- and it now names an anonymous id.
    const removed = await manager.query(
      `UPDATE business.business_staff
          SET status = 'removed', updated_at = now()
        WHERE user_id = $1 AND status <> 'removed'`,
      [userId],
    );

    return {
      moduleKey: this.moduleKey,
      anonymized: Array.isArray(removed) && typeof removed[1] === 'number' ? removed[1] : 0,
      deleted: 0,
      retained: [
        {
          table: 'business.businesses',
          reason: 'a commercial entity with its own staff and bookings; ownership succession is an open product decision',
        },
      ],
    };
  }
}
