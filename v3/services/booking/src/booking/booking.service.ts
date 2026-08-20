import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent } from '@beauclick/events';

import { AvailabilitySlotEntity } from '../entities/availability-slot.entity';
import {
  BOOKING_STATUSES,
  BookingActorType,
  BookingEntity,
  BookingStatus,
  SLOT_HOLDING_STATUSES,
} from '../entities/booking.entity';
import { BookingHistoryEntity, BookingHistoryEvent, BookingHistoryMetadata } from '../entities/booking-history.entity';
import { BookingIdempotencyKeyEntity } from '../entities/booking-idempotency-key.entity';
import { BookingOutboxEntity } from '../entities/booking-outbox.entity';
import { BookingConfig } from '../booking.config';
import {
  InvalidBookingTransitionException,
  RescheduleNotAllowedException,
  SlotUnavailableException,
  TooManyActiveHoldsException,
} from '../booking.errors';

export interface CreateBookingInput {
  customerId: string;
  professionalId: string;
  slotId: string;
  serviceId?: string | null;
  /** Client-supplied retry token. Optional, but every real client should send one. */
  idempotencyKey?: string | null;
}

export interface BookingActor {
  type: BookingActorType;
  id: string | null;
}

/**
 * Every legal transition, in one table.
 *
 * A booking's status is only ever changed by `transition()`, which consults
 * this map AND performs a compare-and-swap against the current status in
 * the same UPDATE. Two independent guards on purpose: the map makes an
 * illegal transition a clear domain error rather than a silent no-op, and
 * the CAS makes a legal-but-raced transition (two confirmations arriving at
 * once) resolve to exactly one winner.
 */
const LEGAL_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  expired: [],
  no_show: [],
};

const SYSTEM_ACTOR: BookingActor = { type: 'system', id: null };

@Injectable()
export class BookingService {
  private readonly auditLog = new Logger('AUDIT:booking');

  constructor(
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    private readonly dataSource: DataSource,
    private readonly config: BookingConfig,
  ) {}

  // ---------------------------------------------------------------------
  // Creation -- the atomic slot claim
  // ---------------------------------------------------------------------

  /**
   * Claims a slot and creates the booking holding it.
   *
   * **The concurrency guarantee, stated precisely.** The claim is a single
   * conditional `UPDATE ... WHERE id = ? AND (status='open' OR (status='held'
   * AND held_until < now()))`. Under PostgreSQL's default READ COMMITTED
   * isolation, a second concurrent UPDATE of the same row blocks on the
   * first transaction's row lock, and on release **re-evaluates its WHERE
   * clause against the newly committed row** (this re-check is specific to
   * UPDATE/DELETE and is exactly why the claim is expressed as one statement
   * rather than SELECT-then-UPDATE). The loser therefore matches zero rows
   * and is rejected. Exactly one caller can ever see `affected === 1`.
   *
   * Accepting an EXPIRED held slot in the same predicate is what keeps the
   * system correct in real time: a customer is blocked only by an ACTIVE
   * hold, never by how recently the expiry sweep last ran. V2's most
   * important availability behaviour, preserved.
   *
   * Three independent layers protect the invariant, not one:
   *   1. this conditional UPDATE (the primary mechanism),
   *   2. `uq_bookings_active_slot` -- a partial UNIQUE index on `slot_id`
   *      restricted to pending/confirmed rows, which makes a second live
   *      booking on one slot structurally impossible even if a future code
   *      path bypassed this method entirely (V2 had no such constraint),
   *   3. the slot's own FK from the booking.
   */
  async create(input: CreateBookingInput, manager?: EntityManager): Promise<BookingEntity> {
    const key = input.idempotencyKey?.trim() || null;

    if (key) {
      const replayed = await this.findByIdempotencyKey(input.customerId, key);
      if (replayed) return replayed;
    }

    try {
      return await this.runInTransaction(manager, (m) => this.createWithin(m, input, key));
    } catch (err) {
      // A concurrent identical request won the race to insert the key row.
      // Its booking is the authoritative one; return that rather than an error.
      if (key && constraintNameOf(err)?.includes('idempotency')) {
        const replayed = await this.findByIdempotencyKey(input.customerId, key);
        if (replayed) return replayed;
      }
      if (isUniqueViolation(err)) throw new SlotUnavailableException();
      throw err;
    }
  }

  private async createWithin(
    manager: EntityManager,
    input: CreateBookingInput,
    idempotencyKey: string | null,
  ): Promise<BookingEntity> {
    const activeHolds = await manager.count(BookingEntity, {
      where: { customerId: input.customerId, status: 'pending' },
    });
    if (activeHolds >= this.config.maxConcurrentHoldsPerCustomer) {
      throw new TooManyActiveHoldsException(this.config.maxConcurrentHoldsPerCustomer);
    }

    const bookingId = uuidv7();
    const now = new Date();
    const holdExpiresAt = new Date(now.getTime() + this.config.holdMinutes * 60_000);

    const slot = await this.claimSlot(manager, input.slotId, input.professionalId, bookingId, holdExpiresAt, now);

    // A slot published for a specific service may only be booked for that
    // service; a slot with no service is generic. Checked after the claim so
    // the claim itself stays a single statement -- the transaction rolls the
    // claim back if this rejects.
    if (slot.serviceId && input.serviceId && slot.serviceId !== input.serviceId) {
      throw new SlotUnavailableException();
    }

    const booking = manager.create(BookingEntity, {
      id: bookingId,
      customerId: input.customerId,
      professionalId: input.professionalId,
      serviceId: input.serviceId ?? slot.serviceId ?? null,
      slotId: slot.id,
      slotStart: slot.startAt,
      slotEnd: slot.endAt,
      status: 'pending',
      holdExpiresAt,
      rescheduleCount: 0,
      cancellationReason: null,
      cancelledByActorType: null,
      cancelledByActorId: null,
      confirmedAt: null,
      completedAt: null,
      cancelledAt: null,
    });
    await manager.insert(BookingEntity, booking);

    if (idempotencyKey) {
      // Inserted in the SAME transaction as the booking, with the result id
      // already known. There is deliberately no "in progress" state: either
      // both rows commit (so a retry replays the real booking) or neither
      // does (so a retry legitimately tries again). A two-phase
      // reserve-then-complete design would strand a client forever whenever
      // the first attempt failed after reserving.
      await manager.insert(BookingIdempotencyKeyEntity, {
        id: uuidv7(),
        scope: 'booking.create',
        ownerId: input.customerId,
        key: idempotencyKey,
        resultId: bookingId,
      });
    }

    await this.recordHistory(manager, {
      bookingId,
      event: 'created',
      fromStatus: null,
      toStatus: 'pending',
      actor: { type: 'customer', id: input.customerId },
      reason: null,
      metadata: { slotId: slot.id, holdExpiresAt: holdExpiresAt.toISOString() },
    });

    await emitEvent(manager, BookingOutboxEntity, {
      aggregateType: 'booking',
      aggregateId: bookingId,
      eventType: 'BookingCreated',
      payload: {
        bookingId,
        professionalId: input.professionalId,
        customerId: input.customerId,
        serviceId: booking.serviceId,
        slotId: slot.id,
        startAt: slot.startAt.toISOString(),
        status: 'pending',
      },
    });

    this.auditLog.log({ action: 'booking.created', bookingId, customerId: input.customerId, slotId: slot.id });
    return manager.findOneOrFail(BookingEntity, { where: { id: bookingId } });
  }

  /** The single conditional UPDATE the whole concurrency guarantee rests on. */
  private async claimSlot(
    manager: EntityManager,
    slotId: string,
    professionalId: string,
    bookingId: string,
    holdExpiresAt: Date,
    now: Date,
  ): Promise<AvailabilitySlotEntity> {
    const result = await manager
      .createQueryBuilder()
      .update(AvailabilitySlotEntity)
      .set({ status: 'held', heldUntil: holdExpiresAt, heldByBookingId: bookingId })
      // Raw snake_case column names: an UPDATE query builder has no alias, so
      // these strings reach SQL verbatim and are NOT rewritten by
      // SnakeNamingStrategy. Phase 1 shipped exactly this bug twice (quoted
      // camelCase in hand-written SQL); the real-PostgreSQL suite is what
      // catches it, since pg-mem generates its own schema and would accept
      // either spelling.
      .where(
        'id = :slotId AND professional_id = :professionalId AND start_at > :now ' +
          "AND (status = 'open' OR (status = 'held' AND held_until < :now))",
        { slotId, professionalId, now },
      )
      .execute();

    if (result.affected !== 1) {
      throw new SlotUnavailableException();
    }

    // Safe to read non-atomically: we now provably own the hold on this row.
    return manager.findOneOrFail(AvailabilitySlotEntity, { where: { id: slotId } });
  }

  // ---------------------------------------------------------------------
  // Lifecycle transitions
  // ---------------------------------------------------------------------

  /**
   * pending -> confirmed. Called when payment is verified (in the SAME
   * transaction as the payment record -- see the checkout orchestrator) or
   * by a professional confirming manually.
   *
   * Returns false rather than throwing when the booking is no longer
   * pending. That is not laxity: it is the exact signal the payment path
   * needs to detect "money moved but the slot is gone" and trigger an
   * automatic refund. Throwing would abort the transaction that just
   * recorded a real payment.
   */
  async confirm(bookingId: string, actor: BookingActor = SYSTEM_ACTOR, manager?: EntityManager): Promise<boolean> {
    return this.runInTransaction(manager, async (m) => {
      const moved = await this.transition(
        m,
        bookingId,
        'confirmed',
        ['pending'],
        actor,
        null,
        { confirmedAt: new Date(), holdExpiresAt: null },
        // Never throw: see transition()'s own note. A booking that expired
        // while the customer was at the gateway must yield false, not abort
        // the payment transaction.
        'report',
      );
      if (!moved) return false;

      const booking = await m.findOneOrFail(BookingEntity, { where: { id: bookingId } });
      await m.update(
        AvailabilitySlotEntity,
        { id: booking.slotId },
        { status: 'booked', heldUntil: null, heldByBookingId: bookingId },
      );

      await emitEvent(m, BookingOutboxEntity, {
        aggregateType: 'booking',
        aggregateId: bookingId,
        eventType: 'BookingConfirmed',
        payload: {
          bookingId,
          professionalId: booking.professionalId,
          customerId: booking.customerId,
          confirmedAt: new Date().toISOString(),
        },
      });

      this.auditLog.log({ action: 'booking.confirmed', bookingId, actorType: actor.type });
      return true;
    });
  }

  /**
   * pending|confirmed -> cancelled, releasing the slot.
   *
   * Emits `BookingCancelled` and stops there. Whether the linked order gets
   * refunded is deliberately NOT decided here -- booking-service does not
   * know commerce or payment exist. V2 established this separation for a
   * good reason (booking fires the fact; payment decides the financial
   * consequence), and inverting it would put refund policy inside the
   * scheduling domain.
   */
  async cancel(
    bookingId: string,
    actor: BookingActor,
    reason: string | null = null,
    manager?: EntityManager,
  ): Promise<boolean> {
    return this.runInTransaction(manager, async (m) => {
      const before = await m.findOne(BookingEntity, { where: { id: bookingId } });
      if (!before) return false;

      // Cancelling an already-terminal booking is a normal, idempotent
      // no-op (a retried request, a double-clicked button), not an error.
      const moved = await this.transition(
        m,
        bookingId,
        'cancelled',
        ['pending', 'confirmed'],
        actor,
        reason,
        {
          cancellationReason: reason,
          cancelledByActorType: actor.type,
          cancelledByActorId: actor.id,
          cancelledAt: new Date(),
          holdExpiresAt: null,
        },
        'report',
      );
      if (!moved) return false;

      await this.releaseSlot(m, before.slotId, bookingId);

      await emitEvent(m, BookingOutboxEntity, {
        aggregateType: 'booking',
        aggregateId: bookingId,
        eventType: 'BookingCancelled',
        payload: {
          bookingId,
          professionalId: before.professionalId,
          customerId: before.customerId,
          slotId: before.slotId,
          previousStatus: before.status,
          cancelledAt: new Date().toISOString(),
          actorType: actor.type,
          actorId: actor.id,
          reason,
        },
      });

      this.auditLog.log({ action: 'booking.cancelled', bookingId, actorType: actor.type, reason });
      return true;
    });
  }

  /** confirmed -> completed. The event later phases (loyalty, referral, reviews) will consume. */
  async complete(bookingId: string, actor: BookingActor, manager?: EntityManager): Promise<boolean> {
    return this.runInTransaction(manager, async (m) => {
      const moved = await this.transition(m, bookingId, 'completed', ['confirmed'], actor, null, {
        completedAt: new Date(),
      });
      if (!moved) return false;

      const booking = await m.findOneOrFail(BookingEntity, { where: { id: bookingId } });
      await emitEvent(m, BookingOutboxEntity, {
        aggregateType: 'booking',
        aggregateId: bookingId,
        eventType: 'BookingCompleted',
        payload: {
          bookingId,
          professionalId: booking.professionalId,
          customerId: booking.customerId,
          serviceId: booking.serviceId,
          completedAt: new Date().toISOString(),
        },
      });
      return true;
    });
  }

  /**
   * confirmed -> no_show. Only after the slot has actually ended -- a
   * professional may never pre-emptively mark a future booking as a
   * no-show. V2's rule, preserved verbatim.
   */
  async markNoShow(bookingId: string, actor: BookingActor, manager?: EntityManager): Promise<boolean> {
    return this.runInTransaction(manager, async (m) => {
      const booking = await m.findOne(BookingEntity, { where: { id: bookingId } });
      if (!booking) return false;
      if (booking.slotEnd.getTime() > Date.now()) {
        throw new InvalidBookingTransitionException(booking.status, 'no_show');
      }
      return this.transition(m, bookingId, 'no_show', ['confirmed'], actor, null, {});
    });
  }

  // ---------------------------------------------------------------------
  // Rescheduling
  // ---------------------------------------------------------------------

  /**
   * Moves a booking to a different slot of the SAME professional and
   * service. Structurally a claim-then-move-then-release, using the exact
   * same atomic claim `create()` uses -- rescheduling introduces no second
   * concurrency primitive.
   *
   * Order matters and is the safety property: the NEW slot is claimed
   * FIRST, so a failure at any point leaves the original booking completely
   * intact. A customer is never left without a booking because a race went
   * the wrong way.
   *
   * Price is deliberately unchanged (same professional, same service), so
   * the linked order needs no adjustment and commerce is not involved at
   * all. Changing professional or service is a different, unbuilt operation.
   */
  async reschedule(
    bookingId: string,
    newSlotId: string,
    actor: BookingActor,
    reason: string | null = null,
    manager?: EntityManager,
  ): Promise<BookingEntity> {
    return this.runInTransaction(manager, async (m) => {
      const booking = await m.findOneOrFail(BookingEntity, { where: { id: bookingId } });

      if (!SLOT_HOLDING_STATUSES.includes(booking.status)) throw new RescheduleNotAllowedException('status');
      if (booking.rescheduleCount >= this.config.maxReschedulesPerBooking) {
        throw new RescheduleNotAllowedException('max_reached');
      }
      const hoursUntil = (booking.slotStart.getTime() - Date.now()) / 3_600_000;
      if (hoursUntil < this.config.rescheduleMinHoursBefore) throw new RescheduleNotAllowedException('too_close');
      if (newSlotId === booking.slotId) throw new RescheduleNotAllowedException('same_slot');

      const newSlot = await m.findOne(AvailabilitySlotEntity, { where: { id: newSlotId } });
      if (
        !newSlot ||
        newSlot.professionalId !== booking.professionalId ||
        (booking.serviceId && newSlot.serviceId && newSlot.serviceId !== booking.serviceId)
      ) {
        throw new RescheduleNotAllowedException('invalid_slot');
      }

      const now = new Date();
      const holdExpiresAt =
        booking.status === 'pending' ? new Date(now.getTime() + this.config.holdMinutes * 60_000) : null;

      // Step 1 -- claim the new slot with the identical atomic predicate.
      const claimed = await this.claimSlot(
        m,
        newSlotId,
        booking.professionalId,
        bookingId,
        holdExpiresAt ?? new Date(now.getTime() + this.config.holdMinutes * 60_000),
        now,
      );

      // Step 2 -- move the booking, compare-and-swapping on the status we
      // validated above, so a concurrent cancel/confirm that landed in
      // between wins and this whole transaction rolls back.
      const moved = await m
        .createQueryBuilder()
        .update(BookingEntity)
        .set({
          slotId: claimed.id,
          slotStart: claimed.startAt,
          slotEnd: claimed.endAt,
          rescheduleCount: booking.rescheduleCount + 1,
          holdExpiresAt: holdExpiresAt,
        })
        .where('id = :id AND status = :status AND reschedule_count = :count', {
          id: bookingId,
          status: booking.status,
          count: booking.rescheduleCount,
        })
        .execute();

      if (moved.affected !== 1) {
        // Rolling back the whole transaction releases the new slot claim
        // too -- no compensating UPDATE needed, unlike V2, which had to
        // hand-roll the rollback because its claim and move were not in one
        // transaction.
        throw new RescheduleNotAllowedException('status');
      }

      // Step 3 -- an already-confirmed booking's new slot becomes booked
      // outright; a pending one's stays held until payment confirms it.
      if (booking.status === 'confirmed') {
        await m.update(
          AvailabilitySlotEntity,
          { id: claimed.id },
          { status: 'booked', heldUntil: null, heldByBookingId: bookingId },
        );
      }

      // Step 4 -- release the old slot.
      await this.releaseSlot(m, booking.slotId, bookingId);

      await this.recordHistory(m, {
        bookingId,
        event: 'rescheduled',
        fromStatus: booking.status,
        toStatus: booking.status,
        actor,
        reason,
        metadata: {
          oldSlotId: booking.slotId,
          newSlotId: claimed.id,
          oldStartAt: booking.slotStart.toISOString(),
          newStartAt: claimed.startAt.toISOString(),
        },
      });

      await emitEvent(m, BookingOutboxEntity, {
        aggregateType: 'booking',
        aggregateId: bookingId,
        eventType: 'BookingRescheduled',
        payload: {
          bookingId,
          professionalId: booking.professionalId,
          customerId: booking.customerId,
          oldSlotId: booking.slotId,
          newSlotId: claimed.id,
          oldStartAt: booking.slotStart.toISOString(),
          newStartAt: claimed.startAt.toISOString(),
          rescheduleCount: booking.rescheduleCount + 1,
        },
      });

      this.auditLog.log({ action: 'booking.rescheduled', bookingId, from: booking.slotId, to: claimed.id });
      return m.findOneOrFail(BookingEntity, { where: { id: bookingId } });
    });
  }

  // ---------------------------------------------------------------------
  // Hold expiry sweep
  // ---------------------------------------------------------------------

  /**
   * The periodic backstop that turns abandoned holds into `expired`
   * bookings and frees their slots.
   *
   * Note this is a BACKSTOP, not the mechanism: the claim predicate already
   * treats a lapsed hold as claimable in real time, so availability is never
   * waiting on this sweep. What the sweep adds is the booking-side truth --
   * moving the abandoned booking out of `pending` so it stops counting
   * against the customer's concurrent-hold cap and stops appearing as live.
   *
   * Each booking is handled in its own transaction so one failure cannot
   * strand the rest of the batch.
   */
  async expireStaleHolds(limit = 100): Promise<number> {
    const stale = await this.bookings.find({
      where: { status: 'pending', holdExpiresAt: LessThan(new Date()) },
      order: { holdExpiresAt: 'ASC' },
      take: limit,
    });

    let expired = 0;
    for (const row of stale) {
      const done = await this.dataSource.transaction(async (m) => {
        // 'report': a payment confirmation that won the race leaves the
        // booking confirmed, and the sweep must simply skip it.
        const moved = await this.transition(
          m,
          row.id,
          'expired',
          ['pending'],
          SYSTEM_ACTOR,
          'hold_expired',
          { holdExpiresAt: null },
          'report',
        );
        if (!moved) return false; // a payment confirmation won the race -- correct outcome, skip.

        await this.releaseSlot(m, row.slotId, row.id);

        await emitEvent(m, BookingOutboxEntity, {
          aggregateType: 'booking',
          aggregateId: row.id,
          eventType: 'BookingExpired',
          payload: {
            bookingId: row.id,
            professionalId: row.professionalId,
            customerId: row.customerId,
            slotId: row.slotId,
            expiredAt: new Date().toISOString(),
          },
        });
        return true;
      });
      if (done) expired += 1;
    }

    if (expired > 0) this.auditLog.log({ action: 'booking.holds_expired', count: expired });
    return expired;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async findById(bookingId: string, manager?: EntityManager): Promise<BookingEntity | null> {
    const repo = manager ? manager.getRepository(BookingEntity) : this.bookings;
    return repo.findOne({ where: { id: bookingId } });
  }

  async listForCustomer(
    customerId: string,
    page: number,
    limit: number,
  ): Promise<{ items: BookingEntity[]; total: number }> {
    const [items, total] = await this.bookings.findAndCount({
      where: { customerId },
      order: { slotStart: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }

  async listForProfessional(
    professionalId: string,
    page: number,
    limit: number,
    statuses?: BookingStatus[],
  ): Promise<{ items: BookingEntity[]; total: number }> {
    const [items, total] = await this.bookings.findAndCount({
      where: {
        professionalId,
        ...(statuses?.length ? { status: In(statuses) } : {}),
      },
      order: { slotStart: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }

  async historyFor(bookingId: string): Promise<BookingHistoryEntity[]> {
    return this.dataSource.getRepository(BookingHistoryEntity).find({
      where: { bookingId },
      order: { id: 'ASC' },
    });
  }

  /** Privacy/account-deletion guard, carried forward from V2: an unresolved commitment blocks erasure. */
  async hasLiveBooking(customerId: string): Promise<boolean> {
    const count = await this.bookings.count({
      where: { customerId, status: In([...SLOT_HOLDING_STATUSES]) },
    });
    return count > 0;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async findByIdempotencyKey(customerId: string, key: string): Promise<BookingEntity | null> {
    const row = await this.dataSource.getRepository(BookingIdempotencyKeyEntity).findOne({
      where: { scope: 'booking.create', ownerId: customerId, key },
    });
    if (!row?.resultId) return null;
    return this.bookings.findOne({ where: { id: row.resultId } });
  }

  /**
   * The ONLY place `bookings.status` is written.
   *
   * Combines the declared transition table with a compare-and-swap in the
   * UPDATE itself. Returns false (never throws) when the CAS matched zero
   * rows, because "somebody else already moved this" is a normal, expected
   * outcome under concurrency that several callers must be able to react to
   * rather than crash on.
   */
  private async transition(
    manager: EntityManager,
    bookingId: string,
    to: BookingStatus,
    allowedFrom: readonly BookingStatus[],
    actor: BookingActor,
    reason: string | null,
    extraFields: Partial<BookingEntity>,
    onIllegal: 'throw' | 'report' = 'throw',
  ): Promise<boolean> {
    const current = await manager.findOne(BookingEntity, { where: { id: bookingId } });
    if (!current) return false;

    if (!allowedFrom.includes(current.status)) {
      // `onIllegal` is a real behavioural choice, not a style knob.
      //
      // 'throw' suits a human-initiated action ("mark this completed") where
      // an impossible transition is worth a 409 the caller can act on.
      //
      // 'report' is REQUIRED for `confirm()`, and this is load-bearing:
      // confirmation runs inside the same transaction that just recorded a
      // real, verified payment. Throwing there would roll that payment back
      // and LOSE A CHARGE THAT ACTUALLY HAPPENED. The caller needs `false`
      // so it can commit the payment and issue a refund instead. An earlier
      // version threw unconditionally, which the payment suite caught by
      // exercising the paid-but-expired path.
      if (onIllegal === 'throw' && !LEGAL_TRANSITIONS[current.status].includes(to)) {
        throw new InvalidBookingTransitionException(current.status, to);
      }
      return false;
    }

    const result = await manager
      .createQueryBuilder()
      .update(BookingEntity)
      .set({ status: to, ...extraFields })
      .where('id = :id AND status IN (:...allowedFrom)', { id: bookingId, allowedFrom: [...allowedFrom] })
      .execute();

    if (result.affected !== 1) return false;

    await this.recordHistory(manager, {
      bookingId,
      event: to as BookingHistoryEvent,
      fromStatus: current.status,
      toStatus: to,
      actor,
      reason,
      metadata: null,
    });
    return true;
  }

  /**
   * Returns a slot to `open`, but only if it is still this booking's slot.
   *
   * The `held_by_booking_id` guard is what stops a late cancellation from
   * stealing a slot another customer has legitimately re-claimed in the
   * meantime -- the same class of bug V2 guarded against by re-checking
   * `held_until` in its sweep, expressed here as explicit ownership rather
   * than an inferred timestamp comparison.
   */
  private async releaseSlot(manager: EntityManager, slotId: string, bookingId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(AvailabilitySlotEntity)
      .set({ status: 'open', heldUntil: null, heldByBookingId: null })
      .where('id = :slotId AND (held_by_booking_id = :bookingId OR held_by_booking_id IS NULL)', { slotId, bookingId })
      .execute();
  }

  private async recordHistory(
    manager: EntityManager,
    input: {
      bookingId: string;
      event: BookingHistoryEvent;
      fromStatus: BookingStatus | null;
      toStatus: BookingStatus | null;
      actor: BookingActor;
      reason: string | null;
      metadata: BookingHistoryMetadata | null;
    },
  ): Promise<void> {
    await manager.insert(BookingHistoryEntity, {
      id: uuidv7(),
      bookingId: input.bookingId,
      event: input.event,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: input.reason,
      metadata: input.metadata,
    });
  }

  /** Joins the caller's transaction when given one, otherwise opens its own. */
  private runInTransaction<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return manager ? fn(manager) : this.dataSource.transaction(fn);
  }
}

export { BOOKING_STATUSES, LEGAL_TRANSITIONS };

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

function constraintNameOf(err: unknown): string | undefined {
  return (err as { constraint?: string } | null)?.constraint;
}
