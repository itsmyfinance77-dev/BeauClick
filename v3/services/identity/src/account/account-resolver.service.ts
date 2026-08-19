import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { UserEntity } from '../entities/user.entity';
import { PhoneConflictEntity } from '../entities/phone-conflict.entity';

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
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(PhoneConflictEntity) private readonly conflictRepo: Repository<PhoneConflictEntity>,
  ) {}

  async resolveOrCreate(phone: string): Promise<UserEntity> {
    const existing = await this.userRepo.findOne({ where: { phone } });
    if (existing) return existing;

    try {
      const created = this.userRepo.create({
        id: uuidv7(),
        phone,
        roles: ['customer'],
        isVerifiedProfessional: false,
        deletedAt: null,
      });
      return await this.userRepo.save(created);
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
