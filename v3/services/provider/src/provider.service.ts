import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { DomainException } from '@beauclick/http';
import { HttpStatus } from '@nestjs/common';
import { ProfessionalEntity, VERIFICATION_STATUSES, VerificationStatus } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';
import { ListProvidersDto } from './dto/list-providers.dto';
import { ProviderEventsService } from './provider-events.service';
import { AuditLogger } from '@beauclick/events';
import { SELLER_OWNER_ROLE_GRANT, SellerOwnerRoleGrantPort } from './ports';

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
    @InjectRepository(CityEntity) private readonly cityRepo: Repository<CityEntity>,
    private readonly events: ProviderEventsService,
    /**
     * V3.3 #75 (`V33-DEC-021`). The owner-role grant, bound by the composition
     * root because `provider` may not import `identity` (ADR-011).
     *
     * NOT `@Optional()`, deliberately. A composition that forgets to bind it
     * fails to boot, which is loud — where a silent fallback would recreate #75
     * exactly: sellers created without the role that makes every seller
     * capability reachable, with nothing failing anywhere.
     */
    @Inject(SELLER_OWNER_ROLE_GRANT) private readonly ownerRoles: SellerOwnerRoleGrantPort,
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

      /*
       * V3.3 #75 (`V33-DEC-021` Rulings 2 and 8). The `professional` role is
       * granted HERE, on the caller's own manager, so the profile row and the
       * role commit together or not at all.
       *
       * Placed after the profile insert and before the outbox event because the
       * grant is a fact ABOUT the ownership that was just established. A failure
       * in the role lookup, the role insert or its audit row aborts this
       * transaction and takes the profile with it -- which is the intended
       * behaviour and not a hazard to route around: a seller who owns a
       * workspace they cannot act on is the defect this story exists to remove.
       *
       * `ownerId` is the SESSION-derived caller, never a DTO field. Verification
       * status is deliberately not consulted: `V33-DEC-021` Ruling 2 makes
       * ownership the trigger, and ADR-042 §4 had already ruled that an
       * unverified professional is a seller whose identity is unconfirmed, not
       * a seller without commercial terms.
       */
      await this.ownerRoles.grantProfessionalOwnerRole(manager, ownerId);

      await this.events.emitProfessionalUpdated(manager, saved.id);
      this.auditLog.log({ action: 'provider.created', ownerId, professionalId: saved.id });
      return manager.getRepository(ProfessionalEntity).findOneOrFail({ where: { id: saved.id }, relations: ['specialties'] });
    });
  }

  /**
   * Reference data for the profile editor's city and specialty pickers.
   *
   * `V3_DOMAIN_BOUNDARIES.md` §provider lists `GET /v1/specialties` in this
   * module's public API; it was never built, and there was no city equivalent
   * either. Until now the only source of either was search's FACETS, which are
   * derived from indexed providers -- so a marketplace with no indexed
   * providers offered a new professional an empty city list and no way to
   * complete their own profile. Reference lookups, not a search surface.
   *
   * Cities are filtered to launched ones: an unlaunched city in the picker is
   * a profile nobody can be found in.
   */
  async listCities(): Promise<CityEntity[]> {
    return this.cityRepo.find({ where: { isLaunched: true }, order: { name: 'ASC' } });
  }

  async listSpecialties(): Promise<SpecialtyEntity[]> {
    return this.specialtyRepo.find({ order: { name: 'ASC' } });
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
    /**
     * Join the caller's transaction when there is one.
     *
     * Phase A's verification workflow must move the professional's status, mark
     * the queue row decided, and write the audit record atomically -- if any of
     * the three fails, none may stand. Opening a nested transaction here would
     * commit the status change independently of the audit row, which is exactly
     * the "audit as best-effort side effect" shape GAP-02-V3 exists to remove.
     *
     * Behaviour is otherwise identical: the same CAS, the same legal-transition
     * assertion, the same single event.
     */
    manager?: EntityManager,
  ): Promise<ProfessionalEntity> {
    const run = async (manager: EntityManager): Promise<ProfessionalEntity> => {
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
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /** Foundation only -- no REST route calls this in Phase 1 (verification workflow/evidence/admin review is out of scope, per this phase's own "do not implement" list). Kept here so the state machine and its invariant (only legal transitions) exist and are tested from day one, per V3_MIGRATION_MATRIX.md's "verification state machine" BUSINESS-RULE EXTRACTION classification. */
  assertValidTransition(from: VerificationStatus, to: VerificationStatus): void {
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      throw new DomainException('VALIDATION_ERROR', `انتقال وضعیت از ${from} به ${to} مجاز نیست.`, HttpStatus.BAD_REQUEST);
    }
  }
}

export { VERIFICATION_STATUSES };
