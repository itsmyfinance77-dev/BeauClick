import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { DomainException } from '@beauclick/http';
import { HttpStatus } from '@nestjs/common';
import { ProfessionalEntity, VERIFICATION_STATUSES, VerificationStatus } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';
import { ListProvidersDto } from './dto/list-providers.dto';

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
  private readonly auditLog = new Logger('AUDIT:provider');

  constructor(
    @InjectRepository(ProfessionalEntity) private readonly repo: Repository<ProfessionalEntity>,
    @InjectRepository(SpecialtyEntity) private readonly specialtyRepo: Repository<SpecialtyEntity>,
  ) {}

  /** ownerId is ALWAYS the session-derived caller -- never accepted from the request body (V3_DOMAIN_BOUNDARIES.md provider section: "No client supplied owner IDs"). */
  async create(ownerId: string, dto: CreateProfessionalDto): Promise<ProfessionalEntity> {
    const existing = await this.repo.findOne({ where: { ownerId } });
    if (existing) throw new ProviderAlreadyExistsException();

    const specialties = dto.specialtyIds?.length
      ? await this.specialtyRepo.find({ where: { id: In(dto.specialtyIds) } })
      : [];

    const entity = this.repo.create({
      id: uuidv7(),
      ownerId,
      displayName: dto.displayName,
      bio: dto.bio ?? null,
      cityId: dto.cityId ?? null,
      specialties,
      verificationStatus: 'unverified',
      deletedAt: null,
    });
    const saved = await this.repo.save(entity);
    this.auditLog.log({ action: 'provider.created', ownerId, professionalId: saved.id });
    return saved;
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
    const entity = await this.repo.findOneOrFail({ where: { id, ownerId, deletedAt: IsNull() }, relations: ['specialties'] });

    if (dto.displayName !== undefined) entity.displayName = dto.displayName;
    if (dto.bio !== undefined) entity.bio = dto.bio;
    if (dto.cityId !== undefined) entity.cityId = dto.cityId;
    if (dto.specialtyIds !== undefined) {
      entity.specialties = dto.specialtyIds.length ? await this.specialtyRepo.find({ where: { id: In(dto.specialtyIds) } }) : [];
    }

    const saved = await this.repo.save(entity);
    this.auditLog.log({ action: 'provider.updated', ownerId, professionalId: id });
    return saved;
  }

  /** Foundation only -- no REST route calls this in Phase 1 (verification workflow/evidence/admin review is out of scope, per this phase's own "do not implement" list). Kept here so the state machine and its invariant (only legal transitions) exist and are tested from day one, per V3_MIGRATION_MATRIX.md's "verification state machine" BUSINESS-RULE EXTRACTION classification. */
  assertValidTransition(from: VerificationStatus, to: VerificationStatus): void {
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      throw new DomainException('VALIDATION_ERROR', `انتقال وضعیت از ${from} به ${to} مجاز نیست.`, HttpStatus.BAD_REQUEST);
    }
  }
}

export { VERIFICATION_STATUSES };
