import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
  SubjectTombstone,
} from '@beauclick/subject-data';

import { ProfessionalEntity } from './entities/professional.entity';
import { ServiceOfferingEntity } from './entities/service-offering.entity';
import { PortfolioItemEntity } from './entities/portfolio-item.entity';
import { ReviewEntity } from './entities/review.entity';
import { VerificationRequestEntity } from './entities/verification-request.entity';
import { ProviderEventsService } from './provider-events.service';

/**
 * provider's subject-data contract.
 *
 * A subject appears in this schema in two completely different capacities and
 * the contract has to handle both, because one person is routinely both:
 *
 *   * as a PROFESSIONAL -- `professionals.owner_id`, and everything hanging
 *     off it: services, portfolio, verification, review replies;
 *   * as a CUSTOMER -- `reviews.customer_id`, the reviews they wrote about
 *     other people's work.
 *
 * THE PART THAT IS EASY TO GET WRONG, and which the erasure test exists for:
 * anonymizing `professionals.display_name` in PostgreSQL does not anonymize
 * the search index. `search.provider_documents` and OpenSearch both hold a
 * copy of the name and the bio, and an erased professional whose name is still
 * returned by `/v1/search` has not been erased in any sense a user would
 * recognise. So erasure sets `deleted_at` and emits `ProfessionalUpdated` in
 * the same transaction -- the existing event that already carries `isDeleted`
 * and already causes the consumer to drop the document. No new event, no new
 * consumer, no second implementation of "this professional is gone".
 */
@Injectable()
export class ProviderSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'provider';

  constructor(private readonly events: ProviderEventsService) {}

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'provider.professionals', disposition: 'subject_data' },
    { table: 'provider.portfolio_items', disposition: 'subject_data' },
    { table: 'provider.reviews', disposition: 'subject_data' },
    { table: 'provider.verification_requests', disposition: 'subject_data' },
    { table: 'provider.verification_request_evidence', disposition: 'subject_data' },
    {
      table: 'provider.services',
      disposition: 'retained',
      reason:
        'A service is a commercial offering -- name, duration, price. It describes work, not a person, and orders and bookings reference it by id.',
    },
    {
      table: 'provider.review_eligibility',
      disposition: 'retained',
      reason:
        'Ids and a completion timestamp only. It is the foreign key that makes "no review without a completed booking" a database fact; deleting it would delete the reviews other customers wrote.',
    },
    {
      table: 'provider.outbox_events',
      disposition: 'retained',
      reason: 'Transactional outbox. Payloads are contract-validated and stripped of unknown keys before they are written.',
    },
    {
      table: 'provider.locations_cities',
      disposition: 'no_subject_data',
      reason: 'Reference data: the city list.',
    },
    {
      table: 'provider.specialties',
      disposition: 'no_subject_data',
      reason: 'Reference data: the specialty taxonomy.',
    },
    {
      table: 'provider.professional_specialties',
      disposition: 'no_subject_data',
      reason: 'Join table between two reference-shaped ids. Carries no subject column and no free text.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const professional = await manager.getRepository(ProfessionalEntity).findOne({ where: { ownerId: userId } });

    const services = professional
      ? await manager.getRepository(ServiceOfferingEntity).find({ where: { professionalId: professional.id } })
      : [];
    const portfolio = professional
      ? await manager.getRepository(PortfolioItemEntity).find({ where: { professionalId: professional.id } })
      : [];
    const verifications = professional
      ? await manager.getRepository(VerificationRequestEntity).find({ where: { professionalId: professional.id } })
      : [];

    const authored = await manager.getRepository(ReviewEntity).find({
      where: { customerId: userId },
      order: { createdAt: 'DESC' },
    });

    const sections: SubjectExportSection[] = [
      {
        key: 'reviews_written',
        description: 'دیدگاه‌هایی که نوشته‌اید',
        rows: authored.map((r) => ({
          id: r.id,
          professionalId: r.professionalId,
          bookingId: r.bookingId,
          rating: r.rating,
          comment: r.comment,
          status: r.status,
          createdAt: r.createdAt,
          // The professional's reply is included: it was written TO the
          // subject, about the subject's own review, and is already public on
          // the professional's profile.
          responseText: r.responseText,
          respondedAt: r.respondedAt,
        })),
      },
    ];

    if (professional) {
      sections.push(
        {
          key: 'professional_profile',
          description: 'نمایه حرفه‌ای شما',
          rows: [
            {
              id: professional.id,
              displayName: professional.displayName,
              bio: professional.bio,
              cityId: professional.cityId,
              verificationStatus: professional.verificationStatus,
              createdAt: professional.createdAt,
              updatedAt: professional.updatedAt,
            },
          ],
        },
        {
          key: 'services',
          description: 'خدمات شما',
          rows: services.map((s) => ({
            id: s.id,
            name: s.name,
            durationMinutes: s.durationMinutes,
            priceToman: s.priceToman,
            deletedAt: s.deletedAt,
            createdAt: s.createdAt,
          })),
        },
        {
          key: 'portfolio',
          description: 'نمونه‌کارهای شما',
          rows: portfolio.map((p) => ({
            id: p.id,
            mediaId: p.mediaId,
            caption: p.caption,
            position: p.position,
            deletedAt: p.deletedAt,
            createdAt: p.createdAt,
          })),
        },
        {
          key: 'verification_requests',
          description: 'درخواست‌های احراز هویت شما',
          rows: verifications.map((v) => ({
            id: v.id,
            status: v.status,
            note: v.note,
            submittedAt: v.submittedAt,
            decidedAt: v.decidedAt,
            // `decisionReason` is a moderator's internal note about the
            // subject. It is the subject's own personal data and is theirs to
            // see -- what is excluded is `decidedBy`, which identifies a
            // different person.
            decisionReason: v.decisionReason,
          })),
        },
      );
    }

    return sections;
  }

  async eraseSubjectData(
    manager: EntityManager,
    userId: string,
    tombstone: SubjectTombstone,
  ): Promise<SubjectErasureOutcome> {
    let anonymized = 0;
    let deleted = 0;

    // ---- as a customer: their own prose, in reviews of other people's work.
    //
    // The RATING survives and the TEXT does not. That split is deliberate: a
    // rating is a fact about the professional's service that other customers
    // and the ranking formula both rely on, and removing it would silently
    // rewrite a professional's average because somebody unrelated closed their
    // account. The comment is the subject's own writing, which prose is
    // identifying in a way a number is not.
    const comments = await manager.query(
      `UPDATE provider.reviews
          SET comment = NULL, updated_at = now()
        WHERE customer_id = $1 AND comment IS NOT NULL`,
      [userId],
    );
    anonymized += rowCount(comments);

    // ---- as a professional
    const professional = await manager.getRepository(ProfessionalEntity).findOne({ where: { ownerId: userId } });
    if (professional) {
      // Their replies to other people's reviews -- their words, same rule.
      const replies = await manager.query(
        `UPDATE provider.reviews
            SET response_text = NULL, responded_at = NULL, updated_at = now()
          WHERE professional_id = $1 AND response_text IS NOT NULL`,
        [professional.id],
      );
      anonymized += rowCount(replies);

      // Evidence rows go entirely: they point at identity documents. The
      // media OBJECTS behind them are owned by this same subject and are
      // destroyed by media's own contract in this same transaction.
      const evidence = await manager.query(
        `DELETE FROM provider.verification_request_evidence e
          USING provider.verification_requests r
          WHERE e.request_id = r.id AND r.professional_id = $1`,
        [professional.id],
      );
      deleted += rowCount(evidence);

      // The request survives as a status record; the prose in it does not.
      const requests = await manager.query(
        `UPDATE provider.verification_requests
            SET note = NULL, decision_reason = NULL
          WHERE professional_id = $1`,
        [professional.id],
      );
      anonymized += rowCount(requests);

      // Captions are the professional's own writing, and the items go with
      // the profile.
      const portfolio = await manager.query(
        `UPDATE provider.portfolio_items
            SET caption = NULL, deleted_at = COALESCE(deleted_at, now())
          WHERE professional_id = $1`,
        [professional.id],
      );
      anonymized += rowCount(portfolio);

      await manager
        .createQueryBuilder()
        .update(ProfessionalEntity)
        .set({
          displayName: tombstone.displayAlias,
          bio: null,
          deletedAt: tombstone.erasedAt,
        })
        .where('id = :id', { id: professional.id })
        .execute();
      anonymized += 1;

      // THE STEP THAT MAKES IT REAL. See the class note: without this the
      // search index keeps serving the old name and bio, and the professional
      // is erased everywhere except the one place the public actually looks.
      // Same transaction as the anonymization, so the two cannot diverge.
      await this.events.emitProfessionalUpdated(manager, professional.id);
    }

    return {
      moduleKey: this.moduleKey,
      anonymized,
      deleted,
      retained: [
        {
          table: 'provider.reviews',
          reason: 'ratings written by the subject survive as facts about the professionals they rated; the text does not',
        },
        {
          table: 'provider.services',
          reason: 'commercial offerings referenced by existing bookings and orders',
        },
      ],
    };
  }
}

/** TypeORM's raw query path returns `[rows, rowCount]` for UPDATE/DELETE. */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
