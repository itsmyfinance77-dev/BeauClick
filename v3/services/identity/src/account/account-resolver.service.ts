import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { UserEntity } from '../entities/user.entity';
import { PhoneConflictEntity } from '../entities/phone-conflict.entity';
import { RoleService } from '../rbac/role.service';

/**
 * V3_SECURITY_MODEL.md §1: "Phone number is the true identity ... new
 * accounts are created from a verified phone, never the reverse ... never
 * silently merge identities on ambiguity." Phone carries a UNIQUE
 * constraint at the schema level, so true ambiguity (two live rows for one
 * phone) cannot occur post-migration -- this resolver's conflict-recording
 * path exists for the one real race it can't prevent structurally: two
 * concurrent first-time verifications for the same phone. The loser of
 * that race gets a recorded conflict instead of a duplicate/failed account,
 * and resolves to the winner's real row on retry.
 */
@Injectable()
export class AccountResolverService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(PhoneConflictEntity) private readonly conflictRepo: Repository<PhoneConflictEntity>,
    private readonly roles: RoleService,
  ) {}

  async resolveOrCreate(phone: string): Promise<UserEntity> {
    const existing = await this.userRepo.findOne({ where: { phone } });
    if (existing) return existing;

    try {
      // The user row and its default role grant are created in ONE
      // transaction, so an account can never exist with no role at all.
      // Phase 1 wrote `roles: ['customer']` straight onto the column and
      // nothing ever wrote it again -- which is R31-01, the reason every
      // privileged capability was ungrantable.
      return await this.dataSource.transaction(async (manager) => {
        const created = manager.getRepository(UserEntity).create({
          id: uuidv7(),
          phone,
          // The denormalized column, kept in sync during the expand window
          // (ADR-016). `identity.user_roles` is the authority.
          roles: [],
          isVerifiedProfessional: false,
          deletedAt: null,
        });
        const saved = await manager.getRepository(UserEntity).save(created);
        const assigned = await this.roles.assignDefaultRole(manager, saved.id);
        await manager.getRepository(UserEntity).update({ id: saved.id }, { roles: assigned });
        saved.roles = assigned;
        return saved;
      });
    } catch {
      // Lost the create race against a concurrent first-time verification
      // for the same phone (unique constraint violation) -- record it,
      // then resolve to the real winning row. Never silently merge, never
      // fail the caller's login.
      const winner = await this.userRepo.findOneOrFail({ where: { phone } });
      await this.conflictRepo.save(
        this.conflictRepo.create({
          id: uuidv7(),
          phone,
          existingUserId: winner.id,
          note: 'Concurrent first-verification race -- resolved to existing row, not merged.',
          resolvedAt: null,
        }),
      );
      return winner;
    }
  }
}
