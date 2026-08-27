import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { DomainException } from '@beauclick/http';
import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { ProviderService } from '../provider.service';
import { ProfessionalEntity } from '../entities/professional.entity';
import { VerificationRequestEntity } from '../entities/verification-request.entity';

export class VerificationAlreadyPendingException extends DomainException {
  constructor() {
    super('CONFLICT', 'درخواست احراز هویت شما در حال بررسی است.', HttpStatus.CONFLICT);
  }
}

export class VerificationNotSubmittableException extends DomainException {
  constructor(message: string) {
    super('CONFLICT', message, HttpStatus.CONFLICT);
  }
}

export class VerificationRequestNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export type VerificationDecision = 'approve' | 'reject';

/**
 * The verification review workflow.
 *
 * WHAT THIS DOES NOT DO: it does not implement a state machine. Phase 3's
 * `ProviderService.transitionVerification()` already is one -- compare-and-swap
 * on the current status, a tested legal-transition table, and an event emitted
 * only by the call that actually made the change. This service calls it. Every
 * state a professional can be in, and every move between them, is still decided
 * there.
 *
 * What was missing was everything around it: no route reached the machine, and
 * there was no record of who asked or who decided. That is what this adds.
 *
 * TRANSITIONS USED, all pre-existing and none invented:
 *   submit   unverified -> pending    (also rejected -> pending, a resubmission)
 *   approve  pending    -> verified
 *   reject   pending    -> rejected
 *
 * `verified -> suspended/revoked` exists in the machine and is deliberately not
 * exposed here: suspension is a different operational action with different
 * consequences, and Phase A's brief scopes this to the submit/decide loop.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly providers: ProviderService,
    @InjectRepository(VerificationRequestEntity)
    private readonly requests: Repository<VerificationRequestEntity>,
    @InjectRepository(ProfessionalEntity)
    private readonly professionals: Repository<ProfessionalEntity>,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * A professional submits for review.
   *
   * `ownerUserId` is the session's own id and the professional is resolved FROM
   * it -- there is no professional parameter on this path, so submitting on
   * somebody else's behalf is not something a check could fail to catch.
   */
  async submit(ownerUserId: string, note: string | null): Promise<VerificationRequestEntity> {
    const professional = await this.providers.findByOwnerId(ownerUserId);
    if (!professional) throw new NotFoundOrNotYoursException();

    if (professional.verificationStatus === 'verified') {
      throw new VerificationNotSubmittableException('پروفایل شما پیش‌تر تأیید شده است.');
    }
    if (professional.verificationStatus === 'pending') {
      throw new VerificationAlreadyPendingException();
    }
    if (professional.verificationStatus === 'suspended' || professional.verificationStatus === 'revoked') {
      throw new VerificationNotSubmittableException(
        'وضعیت پروفایل شما اجازه ارسال درخواست احراز هویت را نمی‌دهد. با پشتیبانی تماس بگیرید.',
      );
    }

    // The status move and the queue row are one transaction: a professional can
    // never be `pending` with nothing in the queue, nor queued without being
    // `pending`.
    return this.dataSource.transaction(async (manager) => {
      const row = manager.getRepository(VerificationRequestEntity).create({
        id: uuidv7(),
        professionalId: professional.id,
        status: 'pending',
        note,
        submittedBy: ownerUserId,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
      });
      await manager.getRepository(VerificationRequestEntity).save(row);

      // The existing machine, called with its existing signature. The partial
      // unique index on (professional_id) WHERE status='pending' is what makes
      // a double submit fail here rather than create a second queue entry.
      await this.providers.transitionVerification(professional.id, 'pending', ownerUserId, null, manager);

      return row;
    });
  }

  /** The professional's own latest request, for their profile screen. */
  async latestFor(ownerUserId: string): Promise<VerificationRequestEntity | null> {
    const professional = await this.providers.findByOwnerId(ownerUserId);
    if (!professional) return null;
    return this.requests.findOne({
      where: { professionalId: professional.id },
      order: { submittedAt: 'DESC' },
    });
  }

  async queue(params: { page: number; limit: number }): Promise<{
    items: Array<VerificationRequestEntity & { displayName: string; cityId: string | null }>;
    total: number;
  }> {
    const [rows, total] = await this.requests.findAndCount({
      where: { status: 'pending', decidedAt: IsNull() },
      order: { submittedAt: 'ASC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });

    // The queue is unusable without knowing WHO each request is for, and the
    // professional's display name is already public on their profile page --
    // so this join exposes nothing that a logged-out visitor cannot already
    // see. Nothing private is added.
    const items = await Promise.all(
      rows.map(async (row) => {
        const professional = await this.professionals.findOne({ where: { id: row.professionalId } });
        return Object.assign(row, {
          displayName: professional?.displayName ?? '—',
          cityId: professional?.cityId ?? null,
        });
      }),
    );

    return { items, total };
  }

  /**
   * A moderator decides.
   *
   * The decision, the professional's status transition, and the audit record
   * are one transaction. If the audit insert fails, the decision does not
   * happen -- which is the property GAP-02-V3 exists to establish.
   */
  async decide(input: {
    requestId: string;
    decision: VerificationDecision;
    actorUserId: string;
    reason: string;
  }): Promise<VerificationRequestEntity> {
    return this.dataSource.transaction(async (manager) => {
      const request = await manager
        .getRepository(VerificationRequestEntity)
        .findOne({ where: { id: input.requestId } });
      if (!request) throw new VerificationRequestNotFoundException();

      const professional = await manager
        .getRepository(ProfessionalEntity)
        .findOne({ where: { id: request.professionalId } });
      if (!professional) throw new VerificationRequestNotFoundException();

      const toStatus = input.decision === 'approve' ? 'verified' : 'rejected';
      const before = professional.verificationStatus;

      // Compare-and-swap on the REQUEST too, not only on the professional. Two
      // moderators deciding the same request simultaneously must produce one
      // decision and one audit row; without this the second would overwrite the
      // first's `decided_by` and the trail would name the wrong person.
      const claimed = await manager
        .createQueryBuilder()
        .update(VerificationRequestEntity)
        .set({
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          decidedBy: input.actorUserId,
          decidedAt: () => 'now()',
          decisionReason: input.reason,
        })
        .where('id = :id AND status = :pending', { id: input.requestId, pending: 'pending' })
        .execute();

      if (claimed.affected !== 1) {
        throw new VerificationNotSubmittableException('این درخواست پیش‌تر بررسی شده است.');
      }

      // The existing state machine. It asserts the transition is legal and
      // throws if it is not -- so an `unverified -> verified` jump is refused
      // here by the same code that has always refused it, not by a new check.
      await this.providers.transitionVerification(
        professional.id,
        toStatus,
        input.actorUserId,
        input.reason,
        manager,
      );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: input.decision === 'approve' ? 'provider.verification_approved' : 'provider.verification_rejected',
        targetType: 'professional',
        targetId: professional.id,
        before: { verificationStatus: before },
        after: { verificationStatus: toStatus, requestId: input.requestId },
        reason: input.reason,
      });

      return manager
        .getRepository(VerificationRequestEntity)
        .findOneOrFail({ where: { id: input.requestId } });
    });
  }
}
