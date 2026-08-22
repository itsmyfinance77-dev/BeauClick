import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';

import { WaitlistEntryEntity } from './entities/waitlist-entry.entity';
import { WaitlistOutboxEntity } from './entities/waitlist-outbox.entity';
import { WaitlistConfig } from './waitlist.config';
import { AlreadyOnWaitlistException, OfferNotAvailableException } from './waitlist.errors';

export interface JoinWaitlistInput {
  customerId: string;
  professionalId: string;
  serviceId: string | null;
}

/**
 * Owns `waitlist.entries` and is the ONE place `status` is written.
 *
 * GAP-26's invariant, restated precisely for this service: nothing here
 * ever touches `booking.availability_slots`. Converting an offer into a
 * real booking is `WaitlistAcceptanceService`'s job (composition root,
 * `apps/api`), because it needs `BookingService`'s atomic claim in the SAME
 * transaction as this service's own CAS -- exactly the shape
 * `CheckoutService` already established for booking+order. This service
 * only ever manages the waitlist's own state machine.
 */
@Injectable()
export class WaitlistService {
  private readonly auditLog = new AuditLogger('waitlist');

  constructor(
    @InjectRepository(WaitlistEntryEntity) private readonly entries: Repository<WaitlistEntryEntity>,
    private readonly dataSource: DataSource,
    private readonly config: WaitlistConfig,
  ) {}

  async join(input: JoinWaitlistInput): Promise<WaitlistEntryEntity> {
    const activeCount = await this.entries.count({
      where: { professionalId: input.professionalId, status: 'waiting' as never },
    });
    if (activeCount >= this.config.maxEntriesPerProfessional) {
      throw new AlreadyOnWaitlistException();
    }

    return this.dataSource.transaction(async (manager) => {
      const id = uuidv7();
      try {
        await manager.insert(WaitlistEntryEntity, {
          id,
          customerId: input.customerId,
          professionalId: input.professionalId,
          serviceId: input.serviceId,
          status: 'waiting',
          offeredSlotId: null,
          offeredAt: null,
          offerExpiresAt: null,
          resultingBookingId: null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AlreadyOnWaitlistException();
        throw err;
      }

      await emitEvent(manager, WaitlistOutboxEntity, {
        aggregateType: 'waitlist_entry',
        aggregateId: id,
        eventType: 'WaitlistJoined',
        payload: {
          entryId: id,
          customerId: input.customerId,
          professionalId: input.professionalId,
          serviceId: input.serviceId,
          joinedAt: new Date().toISOString(),
        },
      });

      this.auditLog.log({ action: 'waitlist.joined', entryId: id, customerId: input.customerId, professionalId: input.professionalId });
      return manager.findOneOrFail(WaitlistEntryEntity, { where: { id } });
    });
  }

  /**
   * The matcher: offers a reopened slot to the earliest eligible waiting
   * entry. `FOR UPDATE SKIP LOCKED` on the candidate row plus the partial
   * unique index on `offered_slot_id` are two independent guards -- the
   * same two-layer discipline `BookingService.claimSlot()` uses -- so an
   * event redelivered while a previous dispatch is still mid-flight cannot
   * offer the same slot twice.
   *
   * Idempotent by inspection first: if this slot already has an active
   * offer (a redelivery of the SAME triggering event), this is a no-op.
   */
  async offerNextFor(professionalId: string, slotId: string, serviceId: string | null): Promise<WaitlistEntryEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const alreadyOffered = await manager.findOne(WaitlistEntryEntity, {
        where: { offeredSlotId: slotId, status: 'offered' as never },
      });
      if (alreadyOffered) return null;

      const offerExpiresAt = new Date(Date.now() + this.config.offerWindowMinutes * 60_000);

      // Raw SQL: the candidate-selection subquery needs FOR UPDATE SKIP LOCKED,
      // which TypeORM's query builder cannot express against a correlated
      // UPDATE ... WHERE id = (SELECT ...) shape.
      //
      // Eligibility, matching booking.service.ts's own claim rule (a slot
      // with no serviceId accepts ANY service, per `claimSlot`'s caller-side
      // check): an entry is eligible when it wants any service
      // (service_id IS NULL), OR the reopened slot itself has no fixed
      // service ($4 IS NULL, so it can satisfy any entry), OR the two
      // service ids match exactly.
      const rows: Array<{ id: string }> = await manager.query(
        `UPDATE waitlist.entries
           SET status = 'offered', offered_slot_id = $1, offered_at = now(), offer_expires_at = $2
         WHERE id = (
           SELECT id FROM waitlist.entries
            WHERE professional_id = $3 AND status = 'waiting'
              AND (service_id IS NULL OR $4::uuid IS NULL OR service_id = $4)
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
        [slotId, offerExpiresAt, professionalId, serviceId],
      );

      if (rows.length === 0) return null;
      const entryId = rows[0].id;
      const entry = await manager.findOneOrFail(WaitlistEntryEntity, { where: { id: entryId } });

      await emitEvent(manager, WaitlistOutboxEntity, {
        aggregateType: 'waitlist_entry',
        aggregateId: entryId,
        eventType: 'WaitlistOffered',
        payload: {
          entryId,
          customerId: entry.customerId,
          professionalId,
          slotId,
          offerExpiresAt: offerExpiresAt.toISOString(),
        },
      });

      this.auditLog.log({ action: 'waitlist.offered', entryId, professionalId, slotId });
      return entry;
    }).catch((err) => {
      // A concurrent matcher invocation offered this exact slot a moment
      // ago and committed first -- uq_waitlist_active_offer_slot is the
      // real backstop behind the pre-check above. Losing this race is the
      // CORRECT outcome (the slot already has an offer out), not an error.
      if (isUniqueViolation(err)) return null;
      throw err;
    });
  }

  /**
   * offered -> accepted, WITHIN A CALLER-SUPPLIED TRANSACTION. Returns the
   * entry so the caller (`WaitlistAcceptanceService`) can read
   * `offeredSlotId`/`serviceId` and attempt the real booking claim in the
   * SAME transaction. If that claim throws, the whole transaction --
   * including this CAS -- rolls back, so the entry is never left
   * `accepted` without a real booking behind it.
   */
  async claimOfferForAcceptance(entryId: string, customerId: string, manager: EntityManager): Promise<WaitlistEntryEntity> {
    const entry = await manager.findOne(WaitlistEntryEntity, { where: { id: entryId } });
    if (!entry || entry.customerId !== customerId || entry.status !== 'offered' || !entry.offeredSlotId) {
      throw new OfferNotAvailableException();
    }
    if (entry.offerExpiresAt && entry.offerExpiresAt.getTime() < Date.now()) {
      throw new OfferNotAvailableException();
    }

    const result = await manager
      .createQueryBuilder()
      .update(WaitlistEntryEntity)
      .set({ status: 'accepted' })
      .where('id = :id AND status = :offered', { id: entryId, offered: 'offered' })
      .execute();

    if (result.affected !== 1) throw new OfferNotAvailableException();
    return manager.findOneOrFail(WaitlistEntryEntity, { where: { id: entryId } });
  }

  /** Called by `WaitlistAcceptanceService` once the real booking exists, in the SAME transaction as claimOfferForAcceptance(). */
  async recordResultingBooking(entryId: string, bookingId: string, manager: EntityManager): Promise<void> {
    await manager.update(WaitlistEntryEntity, { id: entryId }, { resultingBookingId: bookingId });
    const entry = await manager.findOneOrFail(WaitlistEntryEntity, { where: { id: entryId } });
    await emitEvent(manager, WaitlistOutboxEntity, {
      aggregateType: 'waitlist_entry',
      aggregateId: entryId,
      eventType: 'WaitlistAccepted',
      payload: {
        entryId,
        customerId: entry.customerId,
        professionalId: entry.professionalId,
        slotId: entry.offeredSlotId,
        bookingId,
      },
    });
    this.auditLog.log({ action: 'waitlist.accepted', entryId, bookingId });
  }

  /**
   * Called (outside any transaction the failed claim rolled back) when
   * `WaitlistAcceptanceService` catches a lost-the-race claim failure. The
   * slot genuinely belongs to someone else now -- this is a terminal state,
   * not something the matcher re-offers.
   */
  async markMissed(entryId: string): Promise<void> {
    await this.entries
      .createQueryBuilder()
      .update(WaitlistEntryEntity)
      .set({ status: 'missed' })
      .where('id = :id AND status = :offered', { id: entryId, offered: 'offered' })
      .execute();
    this.auditLog.log({ action: 'waitlist.missed', entryId });
  }

  /** offered -> declined. The slot is still open; the caller re-triggers the matcher for it. */
  async decline(entryId: string, customerId: string): Promise<WaitlistEntryEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const entry = await manager.findOne(WaitlistEntryEntity, { where: { id: entryId } });
      if (!entry || entry.customerId !== customerId) return null;

      const result = await manager
        .createQueryBuilder()
        .update(WaitlistEntryEntity)
        .set({ status: 'declined' })
        .where('id = :id AND customer_id = :customerId AND status = :offered', {
          id: entryId,
          customerId,
          offered: 'offered',
        })
        .execute();
      if (result.affected !== 1) return null;

      await emitEvent(manager, WaitlistOutboxEntity, {
        aggregateType: 'waitlist_entry',
        aggregateId: entryId,
        eventType: 'WaitlistDeclined',
        payload: { entryId, customerId, professionalId: entry.professionalId, slotId: entry.offeredSlotId },
      });

      this.auditLog.log({ action: 'waitlist.declined', entryId, customerId });
      return manager.findOneOrFail(WaitlistEntryEntity, { where: { id: entryId } });
    });
  }

  /** waiting -> removed. Voluntary leave while never offered anything. */
  async remove(entryId: string, customerId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(WaitlistEntryEntity)
        .set({ status: 'removed' })
        .where('id = :id AND customer_id = :customerId AND status = :waiting', {
          id: entryId,
          customerId,
          waiting: 'waiting',
        })
        .execute();
      if (result.affected !== 1) return false;

      const entry = await manager.findOneOrFail(WaitlistEntryEntity, { where: { id: entryId } });
      await emitEvent(manager, WaitlistOutboxEntity, {
        aggregateType: 'waitlist_entry',
        aggregateId: entryId,
        eventType: 'WaitlistRemoved',
        payload: { entryId, customerId, professionalId: entry.professionalId },
      });
      return true;
    });
  }

  /**
   * The periodic backstop for abandoned offers -- the same shape as
   * `BookingService.expireStaleHolds()`. Each entry expires in its own
   * transaction so one failure cannot strand the rest of the batch, and
   * emits `WaitlistExpired` so the matcher re-offers the still-open slot to
   * the next candidate.
   */
  async expireStaleOffers(limit = 100): Promise<number> {
    const stale = await this.entries.find({
      where: { status: 'offered' as never, offerExpiresAt: LessThan(new Date()) },
      order: { offerExpiresAt: 'ASC' },
      take: limit,
    });

    let expired = 0;
    for (const row of stale) {
      const done = await this.dataSource.transaction(async (manager) => {
        const result = await manager
          .createQueryBuilder()
          .update(WaitlistEntryEntity)
          .set({ status: 'expired' })
          .where('id = :id AND status = :offered', { id: row.id, offered: 'offered' })
          .execute();
        if (result.affected !== 1) return false; // accepted/declined won the race in between -- correct, skip.

        await emitEvent(manager, WaitlistOutboxEntity, {
          aggregateType: 'waitlist_entry',
          aggregateId: row.id,
          eventType: 'WaitlistExpired',
          payload: {
            entryId: row.id,
            customerId: row.customerId,
            professionalId: row.professionalId,
            slotId: row.offeredSlotId,
          },
        });
        return true;
      });
      if (done) expired += 1;
    }

    if (expired > 0) this.auditLog.log({ action: 'waitlist.offers_expired', count: expired });
    return expired;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async findById(entryId: string): Promise<WaitlistEntryEntity | null> {
    return this.entries.findOne({ where: { id: entryId } });
  }

  async listForCustomer(customerId: string): Promise<WaitlistEntryEntity[]> {
    return this.entries.find({ where: { customerId }, order: { createdAt: 'DESC' } });
  }

  /** The professional's own live queue -- waiting and offered entries, in position order. */
  async listForProfessional(professionalId: string): Promise<WaitlistEntryEntity[]> {
    return this.entries
      .createQueryBuilder('e')
      .where('e.professional_id = :professionalId', { professionalId })
      .andWhere('e.status IN (:...statuses)', { statuses: ['waiting', 'offered'] })
      .orderBy('e.created_at', 'ASC')
      .getMany();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
