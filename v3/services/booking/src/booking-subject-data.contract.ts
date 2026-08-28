import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { BookingEntity } from './entities/booking.entity';

/**
 * booking's subject-data contract.
 *
 * THE EXPORT IS ONE-SIDED, and that is the whole subtlety here. A booking has
 * two parties. The subject's export must contain the bookings they MADE, and
 * must not contain the bookings other people made with them -- a professional
 * downloading their own export must not receive a list of every customer who
 * has ever booked them, because that is fourteen other people's personal data
 * in one file.
 *
 * The professional's own operational view of their bookings already exists,
 * behind their own authenticated routes and shaped for that purpose. An export
 * is not a second, unrestricted copy of it.
 *
 * NOTHING IS DELETED. Bookings are the other party's business records and the
 * ledger's referential ground; once `identity.users` is anonymized the rows
 * describe an appointment rather than a person. What erasure removes is the
 * free text: a cancellation reason the subject typed, and any history entry
 * they authored.
 */
@Injectable()
export class BookingSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'booking';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'booking.bookings', disposition: 'subject_data' },
    { table: 'booking.booking_history', disposition: 'subject_data' },
    {
      table: 'booking.idempotency_keys',
      disposition: 'subject_data',
    },
    {
      table: 'booking.availability_slots',
      disposition: 'no_subject_data',
      reason:
        'A professional\'s published calendar: times and a slot status. `held_by_booking_id` points at a booking, never at a person.',
    },
    {
      table: 'booking.outbox_events',
      disposition: 'retained',
      reason: 'Transactional outbox. Contract-validated payloads carry ids and timestamps.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const bookings = await manager.getRepository(BookingEntity).find({
      where: { customerId: userId },
      order: { createdAt: 'DESC' },
    });

    // Their own history entries, scoped to their own bookings AND to entries
    // they were the actor of. A professional's cancellation of the subject's
    // booking is the professional's action, and the reason they typed is the
    // professional's words.
    const history = await manager.query(
      `SELECT h.id, h.booking_id, h.event, h.from_status, h.to_status, h.reason, h.created_at
         FROM booking.booking_history h
         JOIN booking.bookings b ON b.id = h.booking_id
        WHERE b.customer_id = $1 AND h.actor_id = $1
        ORDER BY h.created_at DESC`,
      [userId],
    );

    return [
      {
        key: 'bookings',
        description: 'رزروهایی که ثبت کرده‌اید',
        rows: bookings.map((b) => ({
          id: b.id,
          professionalId: b.professionalId,
          serviceId: b.serviceId,
          slotStart: b.slotStart,
          slotEnd: b.slotEnd,
          status: b.status,
          cancellationReason: b.cancellationReason,
          confirmedAt: b.confirmedAt,
          completedAt: b.completedAt,
          cancelledAt: b.cancelledAt,
          createdAt: b.createdAt,
        })),
      },
      {
        key: 'booking_history',
        description: 'تغییراتی که خودتان روی رزروهایتان انجام داده‌اید',
        rows: history as Array<Record<string, unknown>>,
      },
    ];
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    let anonymized = 0;
    let deleted = 0;

    const reasons = await manager.query(
      `UPDATE booking.bookings
          SET cancellation_reason = NULL, updated_at = now()
        WHERE customer_id = $1 AND cancellation_reason IS NOT NULL`,
      [userId],
    );
    anonymized += rowCount(reasons);

    // History entries the subject authored. `metadata` goes with the reason:
    // it is a free-form JSON bag written at the point of the action, so it is
    // the one column in this schema whose contents nobody can bound.
    const history = await manager.query(
      `UPDATE booking.booking_history
          SET reason = NULL, metadata = NULL
        WHERE actor_id = $1 AND (reason IS NOT NULL OR metadata IS NOT NULL)`,
      [userId],
    );
    anonymized += rowCount(history);

    // Idempotency keys are ephemeral request bookkeeping keyed by the caller.
    // They protect against a double-submit that can no longer happen, so they
    // are the one thing here with nothing to retain them for.
    const keys = await manager.query('DELETE FROM booking.idempotency_keys WHERE owner_id = $1', [userId]);
    deleted += rowCount(keys);

    return {
      moduleKey: this.moduleKey,
      anonymized,
      deleted,
      retained: [
        {
          table: 'booking.bookings',
          reason:
            "the other party's business record and the ledger's referential ground; anonymous once the identity behind customer_id is destroyed",
        },
      ],
    };
  }
}

function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
