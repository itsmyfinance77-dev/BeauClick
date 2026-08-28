import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
  SubjectTombstone,
} from '@beauclick/subject-data';

import { UserEntity } from './entities/user.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { UserRoleEntity } from './entities/role.entities';
import { OtpRequestEntity } from './entities/otp-request.entity';

/**
 * identity's subject-data contract.
 *
 * **This is the module that makes erasure mean something.** Every other module
 * holds ids, and an id stops describing a person the moment the identity it
 * points at is destroyed. So the platform's whole anonymization model rests on
 * what happens in `eraseSubjectData` below: the phone number, the display
 * name, the sessions, and the one-time codes -- the only material in the
 * platform that identifies a human being directly.
 *
 * Which is also why the ORDER inside erasure matters and is not incidental:
 * `identity.otp_requests` is keyed by phone NUMBER, not by user id, so those
 * rows have to be destroyed while the phone number is still known. Rewriting
 * `users.phone` first would orphan a table full of the number that was
 * supposedly erased, unreachable by any query keyed on the subject.
 */
@Injectable()
export class IdentitySubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'identity';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'identity.users', disposition: 'subject_data' },
    { table: 'identity.otp_requests', disposition: 'subject_data' },
    { table: 'identity.refresh_tokens', disposition: 'subject_data' },
    { table: 'identity.user_roles', disposition: 'subject_data' },
    {
      table: 'identity.phone_conflicts',
      disposition: 'subject_data',
    },
    {
      table: 'identity.roles',
      disposition: 'no_subject_data',
      reason: 'The role catalogue. Rows describe roles, not people.',
    },
    {
      table: 'identity.capabilities',
      disposition: 'no_subject_data',
      reason: 'The capability catalogue.',
    },
    {
      table: 'identity.role_capabilities',
      disposition: 'no_subject_data',
      reason: 'Which role grants which capability. No subject appears in it.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const user = await manager.getRepository(UserEntity).findOne({ where: { id: userId } });
    const sessions = await manager.getRepository(RefreshTokenEntity).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    const roles = await manager.getRepository(UserRoleEntity).find({ where: { userId } });

    return [
      {
        key: 'account',
        description: 'حساب کاربری شما',
        rows: user
          ? [
              {
                id: user.id,
                phone: user.phone,
                displayName: user.displayName,
                isVerifiedProfessional: user.isVerifiedProfessional,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
              },
            ]
          : [],
      },
      {
        key: 'sessions',
        description: 'دستگاه‌ها و نشست‌های شما',
        // `tokenHash` is deliberately absent. It is a credential, and an
        // export document is the last place one belongs -- the subject gains
        // nothing from it and anyone who obtains the document gains a set of
        // hashes to attack offline.
        rows: sessions.map((s) => ({
          id: s.id,
          deviceLabel: s.deviceLabel,
          userAgent: s.userAgent,
          createdAt: s.createdAt,
          lastUsedAt: s.lastUsedAt,
          expiresAt: s.expiresAt,
          revoked: s.revokedAt !== null,
        })),
      },
      {
        key: 'roles',
        description: 'نقش‌های شما در پلتفرم',
        rows: roles.map((r) => ({ roleSlug: r.roleSlug, grantedAt: r.grantedAt, reason: r.reason })),
      },
    ];
  }

  async eraseSubjectData(
    manager: EntityManager,
    userId: string,
    tombstone: SubjectTombstone,
  ): Promise<SubjectErasureOutcome> {
    const user = await manager.getRepository(UserEntity).findOne({ where: { id: userId } });
    if (!user) {
      return { moduleKey: this.moduleKey, anonymized: 0, deleted: 0, retained: [] };
    }

    const originalPhone = user.phone;
    let deleted = 0;

    // FIRST, while the phone number is still known. See the class note: these
    // rows are keyed by phone, and rewriting `users.phone` before this point
    // would leave the number behind in a table nothing can find it in.
    const otpDeleted = await manager
      .getRepository(OtpRequestEntity)
      .createQueryBuilder()
      .delete()
      .where('phone = :phone', { phone: originalPhone })
      .execute();
    deleted += otpDeleted.affected ?? 0;

    // Same reasoning: an unresolved phone conflict records the number.
    const conflictsDeleted = await manager.query('DELETE FROM identity.phone_conflicts WHERE phone = $1', [
      originalPhone,
    ]);
    deleted += Array.isArray(conflictsDeleted) && typeof conflictsDeleted[1] === 'number' ? conflictsDeleted[1] : 0;

    // Every session dies. Revoking rather than deleting would leave
    // `device_label` -- which is user-supplied and routinely a person's name
    // ("گوشی مریم") -- so the rows go entirely.
    const sessionsDeleted = await manager
      .getRepository(RefreshTokenEntity)
      .createQueryBuilder()
      .delete()
      .where('user_id = :userId', { userId })
      .execute();
    deleted += sessionsDeleted.affected ?? 0;

    // Role grants go too. An erased account holding a live `platform_operator`
    // grant is a privileged principal nobody can identify -- and `user_roles`
    // is what `RoleService.resolveAccess` reads when a token is minted.
    const rolesDeleted = await manager
      .getRepository(UserRoleEntity)
      .createQueryBuilder()
      .delete()
      .where('user_id = :userId', { userId })
      .execute();
    deleted += rolesDeleted.affected ?? 0;

    // The row itself SURVIVES, anonymized. Deleting it would break every
    // `customer_id` and `professional.owner_id` in the platform -- bookings a
    // professional still needs, orders the ledger still references -- for no
    // privacy gain, because what those rows would then point at is nothing
    // rather than a person.
    await manager
      .getRepository(UserEntity)
      .createQueryBuilder()
      .update(UserEntity)
      .set({
        phone: tombstone.phoneAlias,
        displayName: null,
        roles: [],
        isVerifiedProfessional: false,
        deletedAt: tombstone.erasedAt,
      })
      .where('id = :userId', { userId })
      .execute();

    return {
      moduleKey: this.moduleKey,
      anonymized: 1,
      deleted,
      retained: [
        {
          table: 'identity.users',
          reason: 'the row survives as an anonymous tombstone so every reference to it stays valid',
        },
      ],
    };
  }
}
