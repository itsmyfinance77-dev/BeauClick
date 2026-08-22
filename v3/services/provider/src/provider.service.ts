import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { DomainException } from '@beauclick/http';
import { HttpStatus } from '@nestjs/common';
import { ProfessionalEntity, VERIFICATION_STATUSES, VerificationStatus } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';
import { ListProvidersDto } from './dto/list-providers.dto';
import { ProviderEventsService } from './provider-events.service';
import { AuditLogger } from '@beauclick/events';

export class ProviderAlreadyExistsException extends DomainException {
  constructor() {
    super('CONFLICT', 'شما پیش‌تر یک پروفایل متخصص ثبت کرده‌اید.', HttpStatus.CONFLICT);
  }
}

/** unverified is the only legal starting point; every other transition needs an explicit, deliberate call -- no route in Phase 1 triggers anything past unverified->pending (the foundation only). */
const VALID_TRANSITIONS: Record<VerificationStatus, VerificationStatus[]> = {
  unverified: ['pending'],
  pending: ['verified', 'rejected'],
  verified: ['suspended', 'revoked'],
  rejected: ['pending'],
  suspended: ['verified', 'revoked'],
  revoked: [],
};

@Injectable()
export class ProviderService {
  private readonly auditLog = new AuditLogger('provider');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ProfessionalEntity) private readonly repo: Repository<ProfessionalEntity>,
    @InjectRepository(SpecialtyEntity) private readonly specialtyRepo: Repository<SpecialtyEntity>,
    private readonly events: ProviderEventsService,
  ) {}

  /** ownerId is ALWAYS the session-derived caller -- never accepted from the request body (V3_DOMAIN_BOUNDARIES.md provider section: "No client supplied owner IDs"). */
  async create(ownerId: string, dto: CreateProfessionalDto): Promise<ProfessionalEntity> {
    const existing = await this.repo.findOne({ where: { ownerId } });
    if (existing) throw new ProviderAlreadyExistsException();

    const specialties = dto.specialtyIds?.length
      ? await this.specialtyRepo.find({ where: { id: In(dto.specialtyIds) } })
      : [];

    // One transaction covering the profile, its revision bump, and the
    // outbox row -- so a professional can never exist without the event that
    // would put them in the search index, and vice versa.
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const entity = manager.getRepository(ProfessionalEntity).create({
        id: uuidv7(),
        ownerId,
        displayName: dto.displayName,
        bio: dto.bio ?? null,
        cityId: dto.cityId ?? null,
        specialties,
        verificationStatus: 'unverified',
        revision: 1,
        deletedAt: null,
      });
      const saved = await manager.getRepository(ProfessionalEntity).save(entity);
      await this.events.emitProfessionalUpdated(manager, saved.id);
      this.auditLog.log({ action: 'provider.created', ownerId, professionalId: saved.id });
      return manager.getRepository(ProfessionalEntity).findOneOrFail({ where: { id: saved.id }, relations: ['specialties'] });
    });
  }

  async findById(id: string): Promise<ProfessionalEntity | null> {
    return this.repo.findOne({ where: { id, deletedAt: IsNull() }, relations: ['specialties'] });
  }

  async findByOwnerId(ownerId: string): Promise<ProfessionalEntity | null> {
    return this.repo.findOne({ where: { ownerId, deletedAt: IsNull() }, relations: ['specialties'] });
  }

  async list(query: ListProvidersDto): Promise<{ items: ProfessionalEntity[]; total: number }> {
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.specialties', 'specialties')
      .where('p.deletedAt IS NULL');

    if (query.cityId) qb.andWhere('p.cityId = :cityId', { cityId: query.cityId });
    if (query.specialtyId) qb.andWhere('specialties.id = :specialtyId', { specialtyId: query.specialtyId });

    const [items, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    return { items, total };
  }

  /**
   * `id` is the resource path param; `ownerId` is the SESSION-derived
   * caller, already verified by OwnershipGuard before this method is ever
   * reached -- this second check is defense-in-depth at the data-access
   * layer itself (the exact GAP-05 pattern: never rely solely on the
   * controller boundary), not a redundant no-op.
   */
  async update(id: string, ownerId: string, dto: UpdateProfessionalDto): Promise<ProfessionalEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // ownerId stays in the WHERE clause: a professional id belonging to
      // someone else fails to load for the same reason a nonexistent one does.
      const entity = await manager
        .getRepository(ProfessionalEntity)
        .findOneOrFail({ where: { id, ownerId, deletedAt: IsNull() }, relations: ['specialties'] });

      if (dto.displayName !== undefined) entity.displayName = dto.displayName;
      if (dto.bio !== undefined) entity.bio = dto.bio;
      if (dto.cityId !== undefined) entity.cityId = dto.cityId;
      if (dto.specialtyIds !== undefined) {
        entity.specialties = dto.specialtyIds.length
          ? await manager.getRepository(SpecialtyEntity).find({ where: { id: In(dto.specialtyIds) } })
          : [];
      }

      await manager.getRepository(ProfessionalEntity).save(entity);
      await this.events.emitProfessionalUpdated(manager, id);
      this.auditLog.log({ action: 'provider.updated', ownerId, professionalId: id });
      return manager.getRepository(ProfessionalEntity).findOneOrFail({ where: { id }, relations: ['specialties'] });
    });
  }

  /**
   * Applies a verification-status transition and announces it.
   *
   * Phase 1 shipped `assertValidTransition` as a tested state machine with no
   * caller, deliberately -- the verification workflow was out of scope. Phase 3
   * gives it one, because search must react to verification (it is a ranking
   * signal and a filter), and the event is the whole point of the coupling
   * being replaced.
   *
   * The transition is a compare-and-swap on the current status, so two
   * concurrent transitions resolve to exactly one winner and exactly one event.
   */
  async transitionVerification(
    id: string,
    toStatus: VerificationStatus,
    actorId: string | null,
    reason: string | null,
  ): Promise<ProfessionalEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const before = await manager
        .getRepository(ProfessionalEntity)
        .findOneOrFail({ where: { id, deletedAt: IsNull() } });

      this.assertValidTransition(before.verificationStatus, toStatus);

      const result = await manager
        .createQueryBuilder()
        .update(ProfessionalEntity)
        .set({ verificationStatus: toStatus })
        .where('id = :id AND verification_status = :from', { id, from: before.verificationStatus })
        .execute();

      if (result.affected !== 1) {
        // Lost the race: another transition committed first. Not an error --
        // but this call must not emit an event for a change it did not make.
        return manager.getRepository(ProfessionalEntity).findOneOrFail({ where: { id } });
      }

      await this.events.emitVerificationChanged(manager, id, before.verificationStatus, toStatus, actorId, reason);
      this.auditLog.log({ action: 'provider.verification_changed', professionalId: id, from: before.verificationStatus, to: toStatus, actorId });
      return manager.getRepository(ProfessionalEntity).findOneOrFail({ where: { id } });
    });
  }

  /** Foundation only -- no REST route calls this in Phase 1 (verification workflow/evidence/admin review is out of scope, per this phase's own "do not implement" list). Kept here so the state machine and its invariant (only legal transitions) exist and are tested from day one, per V3_MIGRATION_MATRIX.md's "verification state machine" BUSINESS-RULE EXTRACTION classification. */
  assertValidTransition(from: VerificationStatus, to: VerificationStatus): void {
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      throw new DomainException('VALIDATION_ERROR', `انتقال وضعیت از ${from} به ${to} مجاز نیست.`, HttpStatus.BAD_REQUEST);
    }
  }
}

export { VERIFICATION_STATUSES };
