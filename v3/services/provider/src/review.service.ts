import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { DomainException } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { AdminAuditService } from '@beauclick/audit';

import { ReviewEntity } from './entities/review.entity';
import { ReviewEligibilityEntity } from './entities/review-eligibility.entity';
import { ProfessionalEntity } from './entities/professional.entity';
import { ProviderEventsService } from './provider-events.service';

export class ReviewNotEligibleException extends DomainException {
  constructor(message: string) {
    super('REVIEW_NOT_ELIGIBLE', message, HttpStatus.CONFLICT);
  }
}

export class ReviewAlreadyExistsException extends DomainException {
  constructor() {
    super('CONFLICT', 'برای این رزرو پیش‌تر دیدگاه ثبت کرده‌اید.', HttpStatus.CONFLICT);
  }
}

export class ReviewConflictException extends DomainException {
  constructor(message: string) {
    super('CONFLICT', message, HttpStatus.CONFLICT);
  }
}

export type ModerationDecision = 'hide' | 'publish';

/**
 * Reviews: the write path, the professional's reply, and moderation.
 *
 * THE ELIGIBILITY RULE IS NOT IN THIS FILE, and that is the point. Phase D
 * requires eligibility to be "proven server-side from booking data, never
 * asserted by the client", and the strongest available form of that is a
 * database constraint rather than a check in a service:
 *
 *   * `reviews.booking_id` REFERENCES `review_eligibility(booking_id)` — a
 *     review of a booking that never completed has nothing to point at.
 *   * `uq_reviews_booking` — a second review for one booking loses to the
 *     index, not to a read-then-write two concurrent requests can both pass.
 *
 * What this file adds on top is the one thing a constraint cannot express:
 * that the CALLER is the customer named on the eligibility row. That is read
 * from provider's own projection of `BookingCompleted`, never from the
 * request, so there is no customer id on any route for a client to tamper
 * with.
 *
 * Ordering note that matters for moderation: a review is PUBLIC and COUNTED
 * the moment it is written. Phase D's Definition of Done requires
 * `review_count > 0` and the `high_rating` badge to be awarded, and neither
 * can happen if every review waits for a human first. Moderation is therefore
 * a takedown path, and `ReviewModerated` carries the ranking contribution back
 * out again — see that contract for why shipping only `ReviewCreated` would
 * have left moderation decorative.
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger('ReviewService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ReviewEntity) private readonly reviews: Repository<ReviewEntity>,
    @InjectRepository(ReviewEligibilityEntity) private readonly eligibility: Repository<ReviewEligibilityEntity>,
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    private readonly events: ProviderEventsService,
    private readonly audit: AdminAuditService,
  ) {}

  // -------------------------------------------------------- eligibility

  /**
   * Records that a booking completed, making it reviewable.
   *
   * Called by the `BookingCompleted` consumer. `ON CONFLICT DO NOTHING` is the
   * whole idempotency story because `booking_id` is the primary key — a
   * redelivery writes nothing and reports nothing wrong, which is the correct
   * outcome for an at-least-once event rather than an error to log.
   */
  async recordEligibility(input: {
    bookingId: string;
    professionalId: string;
    customerId: string;
    serviceId: string | null;
    completedAt: Date;
  }): Promise<void> {
    await this.eligibility.query(
      `INSERT INTO provider.review_eligibility (booking_id, professional_id, customer_id, service_id, completed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (booking_id) DO NOTHING`,
      [input.bookingId, input.professionalId, input.customerId, input.serviceId, input.completedAt],
    );
  }

  // -------------------------------------------------------------- write

  /**
   * A customer reviews their own completed booking.
   *
   * `customerUserId` is the session's own id. The professional is read from
   * the eligibility row, never from the request, so "review on somebody else's
   * behalf" and "attribute a review to a professional who was not there" are
   * both requests this API cannot express.
   */
  async create(input: {
    bookingId: string;
    customerUserId: string;
    rating: number;
    comment: string | null;
  }): Promise<ReviewEntity> {
    return this.dataSource.transaction(async (manager) => {
      const eligible = await manager
        .getRepository(ReviewEligibilityEntity)
        .findOne({ where: { bookingId: input.bookingId } });

      // One refusal for "no such booking", "not completed", and "not yours".
      // A customer who can distinguish those three has an oracle for other
      // people's booking ids and their states.
      if (!eligible || eligible.customerId !== input.customerUserId) {
        throw new ReviewNotEligibleException('برای این رزرو امکان ثبت دیدگاه وجود ندارد.');
      }

      const review = manager.getRepository(ReviewEntity).create({
        id: uuidv7(),
        bookingId: input.bookingId,
        professionalId: eligible.professionalId,
        customerId: eligible.customerId,
        rating: input.rating,
        comment: input.comment,
        status: 'published',
        responseText: null,
        respondedAt: null,
        moderatedBy: null,
        moderatedAt: null,
        moderationReason: null,
      });

      try {
        await manager.getRepository(ReviewEntity).insert(review);
      } catch (error) {
        // The UNIQUE index is what refuses a second review, including when two
        // requests arrive simultaneously and both read no existing row. A
        // pre-check would narrow the window; only the constraint closes it.
        if (isUniqueViolation(error)) throw new ReviewAlreadyExistsException();
        throw error;
      }

      // Same transaction as the write. Search learns about the rating only if
      // the review actually committed.
      await this.events.emitReviewCreated(manager, review);

      return review;
    });
  }

  // --------------------------------------------------------------- read

  /** A professional's published reviews, newest first. Public. */
  async listForProfessional(
    professionalId: string,
    params: { page: number; limit: number },
  ): Promise<{ items: ReviewEntity[]; total: number }> {
    const [items, total] = await this.reviews.findAndCount({
      where: { professionalId, status: 'published' },
      order: { createdAt: 'DESC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
    return { items, total };
  }

  /**
   * The rating summary for a set of professionals, in one query.
   *
   * COMPUTED FROM THE REVIEWS, not read back from `search.ranking_signals`.
   * The signal row is a projection maintained for RANKING and is eventually
   * consistent by design; a profile page showing an average that disagrees
   * with the reviews printed beneath it is a discrepancy nobody can explain to
   * a customer. The two are expected to agree and a test asserts they do — but
   * when they briefly do not, the profile shows the truth.
   *
   * Batched for the same reason `imagesForMany` is: a 20-item listing must not
   * become 20 sequential aggregate queries.
   */
  async ratingSummaryFor(professionalIds: string[]): Promise<Map<string, { average: number; count: number }>> {
    const ids = professionalIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return new Map();

    const rows = await this.reviews
      .createQueryBuilder('r')
      .select('r.professional_id', 'professionalId')
      .addSelect('AVG(r.rating)', 'avg')
      .addSelect('COUNT(*)', 'count')
      .where('r.professional_id IN (:...ids) AND r.status = :status', { ids, status: 'published' })
      .groupBy('r.professional_id')
      .getRawMany<{ professionalId: string; avg: string; count: string }>();

    const out = new Map<string, { average: number; count: number }>();
    for (const row of rows) {
      // Rounded to one decimal at the edge rather than stored rounded: the
      // ranking formula wants the unrounded value, and a display concern must
      // not change what the scorer sees.
      out.set(row.professionalId, {
        average: Math.round(Number(row.avg) * 10) / 10,
        count: Number(row.count),
      });
    }
    return out;
  }

  /** The caller's own reviews, so a client can tell which bookings it has already reviewed. */
  async listForCustomer(customerUserId: string, params: { page: number; limit: number }): Promise<{ items: ReviewEntity[]; total: number }> {
    const [items, total] = await this.reviews.findAndCount({
      where: { customerId: customerUserId },
      order: { createdAt: 'DESC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
    return { items, total };
  }

  // ----------------------------------------------------------- response

  /**
   * The professional replies, publicly, to a review of their own work.
   *
   * Scoped by `professionalId` as well as by review id, so another
   * professional's review id resolves exactly the way a nonexistent one does —
   * the same pairing every other mutating route in this module uses alongside
   * its ownership guard.
   *
   * A reply can be edited (it is the professional's own words) but a review
   * cannot: allowing the reply to change while the review is fixed is the
   * asymmetry the product wants, and it is stated here rather than left to be
   * inferred from which routes happen to exist.
   */
  async respond(professionalId: string, reviewId: string, text: string): Promise<ReviewEntity> {
    const result = await this.reviews
      .createQueryBuilder()
      .update(ReviewEntity)
      .set({ responseText: text, respondedAt: () => 'now()' })
      .where('id = :id AND professional_id = :professionalId', { id: reviewId, professionalId })
      .execute();

    if (result.affected !== 1) throw new NotFoundOrNotYoursException();
    return this.reviews.findOneOrFail({ where: { id: reviewId } });
  }

  // --------------------------------------------------------- moderation

  /**
   * The untriaged queue: reviews no moderator has decided on yet.
   *
   * Oldest first, matching the verification queue — a queue a moderator works
   * through newest-first is a queue whose tail is never reached.
   */
  async moderationQueue(params: { page: number; limit: number }): Promise<{
    items: Array<ReviewEntity & { displayName: string }>;
    total: number;
  }> {
    const [rows, total] = await this.reviews.findAndCount({
      where: { moderatedAt: IsNull() },
      order: { createdAt: 'ASC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });

    // The professional's display name is already public on their profile, so
    // this join exposes nothing a logged-out visitor cannot see. The same
    // reasoning the verification queue records.
    const items = await Promise.all(
      rows.map(async (row) => {
        const professional = await this.professionals.findOne({ where: { id: row.professionalId } });
        return Object.assign(row, { displayName: professional?.displayName ?? '—' });
      }),
    );

    return { items, total };
  }

  /**
   * A moderator decides a review's visibility.
   *
   * The decision, the status change, the event, and the audit record are ONE
   * transaction. If the audit insert fails the takedown does not happen —
   * GAP-02-V3's property, applied to a mutation that removes somebody's
   * published opinion from public view.
   *
   * `publish` on an untriaged review changes no visibility and still records a
   * decision: "a moderator looked at this and it is fine" is a real outcome,
   * and without a way to record it the only way to clear the queue would be to
   * hide things.
   */
  async moderate(input: {
    reviewId: string;
    decision: ModerationDecision;
    actorUserId: string;
    reason: string;
  }): Promise<ReviewEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ReviewEntity);
      const review = await repo.findOne({ where: { id: input.reviewId } });
      if (!review) throw new NotFoundOrNotYoursException();

      const toStatus = input.decision === 'hide' ? 'hidden' : 'published';
      const fromStatus = review.status;

      // Compare-and-swap, with a second clause that is NOT decoration.
      //
      // `status = :fromStatus` alone handles two moderators whose transactions
      // genuinely overlap: the second blocks on the row lock, re-evaluates its
      // predicate against the newly committed row, and matches nothing.
      //
      // It does NOT handle the sequential case, and that gap was real: a second
      // moderator hitting `hide` on an already-hidden review reads
      // `fromStatus = 'hidden'`, computes `toStatus = 'hidden'`, and its CAS
      // matches its own no-op -- so the decision "succeeded", a second audit row
      // was written, and `moderated_by` was overwritten with the wrong person.
      // The takedown would then be attributed to whoever pressed the button
      // last. Found by the concurrency test, which caught it as a sequential
      // race rather than an overlapping one.
      //
      // `(status <> :toStatus OR moderated_at IS NULL)` closes it while keeping
      // the one legitimate no-op transition: deciding to KEEP an untriaged
      // published review changes no status and must still be recordable, or the
      // only way to drain the queue would be to hide things.
      const claimed = await manager
        .createQueryBuilder()
        .update(ReviewEntity)
        .set({
          status: toStatus,
          moderatedBy: input.actorUserId,
          moderatedAt: () => 'now()',
          moderationReason: input.reason,
        })
        .where('id = :id AND status = :fromStatus AND (status <> :toStatus OR moderated_at IS NULL)', {
          id: input.reviewId,
          fromStatus,
          toStatus,
        })
        .execute();

      if (claimed.affected !== 1) {
        throw new ReviewConflictException('این دیدگاه پیش‌تر بررسی شده است.');
      }

      // Emitted ONLY when the visibility actually changed. A `publish` decision
      // on an already-published review is a triage record, not a ranking event,
      // and emitting one would make search apply a compensating signal for a
      // contribution that was never removed.
      if (fromStatus !== toStatus) {
        await this.events.emitReviewModerated(manager, {
          reviewId: review.id,
          professionalId: review.professionalId,
          rating: review.rating,
          fromStatus,
          toStatus,
          actorId: input.actorUserId,
        });
      }

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: input.decision === 'hide' ? 'provider.review_hidden' : 'provider.review_published',
        targetType: 'review',
        targetId: review.id,
        // The review's own TEXT is never in the snapshot -- customer-authored
        // prose, excluded by construction the same way it is from the event.
        before: { status: fromStatus },
        after: { status: toStatus, professionalId: review.professionalId },
        reason: input.reason,
      });

      return repo.findOneOrFail({ where: { id: input.reviewId } });
    });
  }
}

/** PostgreSQL's unique-violation SQLSTATE, via whichever driver shape TypeORM hands back. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}
