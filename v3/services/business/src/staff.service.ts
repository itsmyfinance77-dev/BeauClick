import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity, BusinessStaffRole } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { InviteStaffDto } from './dto/staff.dto';
import { StaffInviteRejectedException, StaffMembershipNotFoundException } from './business.errors';

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
  ) {}

  /** The session's relationship to this business, or null if it has none. */
  async roleFor(businessId: string, userId: string): Promise<BusinessRole | null> {
    const business = await this.businesses.findOne({ where: { id: businessId } });
    if (!business) return null;
    if (business.ownerId === userId) return 'owner';

    const membership = await this.staff.findOne({ where: { businessId, userId, status: 'active' } });
    return membership?.role ?? null;
  }

  async invite(businessId: string, invitedBy: string, dto: InviteStaffDto): Promise<BusinessStaffEntity> {
    if (dto.userId === invitedBy) {
      throw new StaffInviteRejectedException('نمی‌توانید خودتان را دعوت کنید.');
    }

    return this.dataSource.transaction(async (manager) => {
      const id = uuidv7();
      try {
        await manager.insert(BusinessStaffEntity, {
          id,
          businessId,
          userId: dto.userId,
          professionalId: dto.professionalId ?? null,
          role: dto.role,
          status: 'invited',
          invitedBy,
          respondedAt: null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new StaffInviteRejectedException('این کاربر قبلاً عضو یا دعوت‌شده این کسب‌وکار است.', {
            constraint: constraintNameOf(err),
          });
        }
        throw err;
      }

      await emitEvent(manager, BusinessOutboxEntity, {
        aggregateType: 'business_staff',
        aggregateId: id,
        eventType: 'StaffInvited',
        payload: { staffId: id, businessId, userId: dto.userId, role: dto.role, invitedBy },
      });

      this.auditLog.log({ action: 'business.staff_invited', businessId, staffId: id, userId: dto.userId, role: dto.role });
      return manager.findOneOrFail(BusinessStaffEntity, { where: { id } });
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

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

function constraintNameOf(err: unknown): string | undefined {
  return (err as { constraint?: string } | null)?.constraint;
}
