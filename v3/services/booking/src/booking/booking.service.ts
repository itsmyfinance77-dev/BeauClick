import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import {
  BOOKING_CANCELLATION_ENTITLEMENT_HOOK,
  BOOKING_RESCHEDULE_OUTCOME_HOOK,
  BookingCancellationEntitlementHook,
  BookingRescheduleFacts,
  BookingRescheduleGovernance,
  BookingRescheduleOutcomeHook,
  ELIGIBLE_RESOURCE_DIRECTORY,
  EligibleResourceDirectory,
  lockResourceForAssignment,
} from '../ports';
import { emitEvent, AuditLogger } from '@beauclick/events';

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
import { BookingResourceAssignmentEntity } from '../entities/booking-resource-assignment.entity';
import { BookingConfig } from '../booking.config';
import {
  InvalidBookingTransitionException,
  RescheduleConsequenceRequiredException,
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

/** V3.3 #160 (`#42c`). How a reschedule request was confirmed by its caller. */
export interface RescheduleOptions {
  /** The customer's explicit confirmation of a non-free reschedule's consequence. */
  acceptConsequence?: boolean;
}

/**
 * The database facts of one booking's cancellation — V3.3 #160 (`#42c`),
 * `V33-DEC-039` R4.
 *
 * Read from the booking and its `cancelled` history row, on the caller's
 * transaction. `eventInstant` is that history row's `created_at`: the database
 * clock of the CANCELLING transaction, not of whoever reads it later. Instants
 * cross as text so no JavaScript `Date` ever truncates a microsecond off the
 * boundary, and `timely` is computed in the same SQL statement.
 */
export interface BookingCancellationFacts {
  readonly cancelledByActorType: BookingActorType;
  readonly wasConfirmed: boolean;
  readonly eventInstant: string;
  /** `slot_start − cutoff_hours`; `null` when no cutoff was supplied. */
  readonly cutoffInstant: string | null;
  /** `eventInstant <= cutoffInstant`; `null` when no cutoff was supplied. */
  readonly timely: boolean | null;
}

/** ISO-8601 UTC with microseconds, so a `timestamptz` survives the round trip exactly. */
const ISO_MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

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
  private readonly auditLog = new AuditLogger('booking');

  constructor(
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    private readonly dataSource: DataSource,
    private readonly config: BookingConfig,
    /**
     * V3.3 #58 (`#58a`). **Mandatory**, deliberately without `@Optional()`.
     *
     * A cancellation that silently skipped the entitlement seam would owe a
     * seller a credit that no row records, and nothing in the response or the
     * logs would say so. A composition missing the binding fails to construct
     * at boot instead.
     */
    @Inject(BOOKING_CANCELLATION_ENTITLEMENT_HOOK)
    private readonly cancellationEntitlement: BookingCancellationEntitlementHook,
    /**
     * V3.3 #128 (`#110b`). **Mandatory**, deliberately without `@Optional()`
     * -- the same reasoning `cancellationEntitlement` above already carries:
     * a composition missing the binding must fail to construct rather than
     * silently booking every resource-requiring service with no assignment
     * at all.
     */
    @Inject(ELIGIBLE_RESOURCE_DIRECTORY)
    private readonly eligibleResources: EligibleResourceDirectory,
    /**
     * V3.3 #160 (`#42c`). **Mandatory**, deliberately without `@Optional()`,
     * for the reason the two seams above carry: a composition missing it would
     * silently keep today's guards for every booking whose customer accepted
     * outcome terms.
     */
    @Inject(BOOKING_RESCHEDULE_OUTCOME_HOOK)
    private readonly rescheduleOutcome: BookingRescheduleOutcomeHook,
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
      // A concurrent identical request may have already won -- checked on
      // ANY failure when a key was supplied, not only a caught unique
      // violation on the idempotency-key insert itself.
      //
      // That narrower check alone MISSES a real case under N-way (N>2)
      // concurrent identical retries: at most one of them can ever win
      // claimSlot() (only one slot exists), so every other one throws
      // SlotUnavailableException directly out of claimSlot() -- a plain JS
      // exception with no `.constraint` -- WITHOUT ever reaching the
      // idempotency-key insert whose violation this catch was watching
      // for. Those callers got no idempotency protection at all: a losing
      // retry with the exact key the winner used was told the slot was
      // gone instead of being handed the winner's own booking, which is
      // what "idempotent retry" is supposed to mean. The fix widens WHEN
      // this check runs, not what it does -- findByIdempotencyKey() is
      // already exact-key-scoped, so it can only ever return the real
      // result of THIS key's request, never an unrelated booking.
      if (key) {
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

    // V3.3 #128 (`#110b`), ADR-049 §6.4. Inside the SAME transaction as the
    // slot claim and the booking insert, so there is no window in which the
    // booking exists without its resource or vice versa. Resolves to no
    // assignment for a null service, a null delivery location, or a service
    // with no requirement (`V33-DEC-034` R4) -- see `syncResourceAssignment`.
    await this.syncResourceAssignment(manager, bookingId, booking.serviceId, slot.deliveryLocationId, slot.startAt, slot.endAt);

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

      /*
       * V3.3 #58 (`#58a`), ADR-046 §8. The entitlement seam, inside THIS
       * transaction.
       *
       * booking-service does not know what a credit is; it offers the
       * transaction and the two facts the decision needs -- who cancelled, and
       * whether the booking had actually been confirmed. An expired pending
       * hold consumed nothing, so `wasConfirmed` false returns nothing.
       *
       * Mandatory and unconditional: a cancellation that rolls back must leave
       * no return, and a failed return must roll back the cancellation.
       */
      await this.cancellationEntitlement.onBookingCancellation(
        m,
        bookingId,
        actor.type,
        before.status === 'confirmed',
      );

      await this.releaseSlot(m, before.slotId, bookingId);

      // V3.3 #128 (`#110b`). Same transaction as the cancellation, so a
      // rollback of either rolls back both. Idempotent: a booking with no
      // assignment, or one already `released`, matches zero rows and is a
      // silent no-op.
      await this.releaseResourceAssignment(m, bookingId);

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
    options: RescheduleOptions = {},
  ): Promise<BookingEntity> {
    return this.runInTransaction(manager, async (m) => {
      /*
       * V3.3 #160 (`#42c`), `V33-DEC-039` R8. A CUSTOMER's reschedule of a
       * booking whose order carries accepted outcome terms is governed by those
       * terms instead of the two environment guards below. The seam runs first
       * and, when governed, takes the order row `FOR UPDATE` before this method
       * locks the booking row (ADR-050's order → booking).
       *
       * A professional's reschedule never asks, and a customer's reschedule of a
       * booking without terms is answered `governed: false`: both continue on
       * exactly the path this method has always taken.
       */
      const governance: BookingRescheduleGovernance =
        actor.type === 'customer' ? await this.rescheduleOutcome.governReschedule(m, bookingId) : { governed: false };

      const booking = governance.governed
        ? await m.findOneOrFail(BookingEntity, { where: { id: bookingId }, lock: { mode: 'pessimistic_write' } })
        : await m.findOneOrFail(BookingEntity, { where: { id: bookingId } });

      if (!SLOT_HOLDING_STATUSES.includes(booking.status)) throw new RescheduleNotAllowedException('status');
      if (!governance.governed) {
        if (booking.rescheduleCount >= this.config.maxReschedulesPerBooking) {
          throw new RescheduleNotAllowedException('max_reached');
        }
        const hoursUntil = (booking.slotStart.getTime() - Date.now()) / 3_600_000;
        if (hoursUntil < this.config.rescheduleMinHoursBefore) throw new RescheduleNotAllowedException('too_close');
      }
      if (newSlotId === booking.slotId) throw new RescheduleNotAllowedException('same_slot');

      const newSlot = await m.findOne(AvailabilitySlotEntity, { where: { id: newSlotId } });
      if (
        !newSlot ||
        newSlot.professionalId !== booking.professionalId ||
        (booking.serviceId && newSlot.serviceId && newSlot.serviceId !== booking.serviceId)
      ) {
        throw new RescheduleNotAllowedException('invalid_slot');
      }

      // `null` for a free governed reschedule; throws when the consequence is
      // unavailable or not yet confirmed -- before anything is written.
      const consequence = governance.governed
        ? await this.governedRescheduleConsequence(m, booking, governance, options)
        : null;

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

      // Step 1.5 -- resolve the resource for the DESTINATION slot, re-
      // evaluating delivery location and required kind from scratch rather
      // than carrying the old resource forward (`V33-DEC-034` R4/R7): the
      // destination may need no resource at all, the same kind, or (if the
      // professional's branch context differs) a different one entirely.
      // `syncResourceAssignment` mutates the SAME assignment row this
      // booking has always had, if any -- see that method's own docs. A
      // throw here rolls back Step 1's slot claim too, leaving the
      // ORIGINAL booking, slot and assignment completely untouched.
      await this.syncResourceAssignment(m, bookingId, booking.serviceId, claimed.deliveryLocationId, claimed.startAt, claimed.endAt);

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

      // V3.3 #160 (`#42c`). The accepted consequence, in THIS transaction: the
      // move and its decision commit together or not at all.
      if (governance.governed && consequence) {
        await this.rescheduleOutcome.recordConsequence(m, governance, consequence);
      }

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

  /**
   * Classifies a governed customer reschedule — V3.3 #160 (`#42c`),
   * `V33-DEC-039` R8, on the database clock of THIS transaction.
   *
   * Free iff the booking's prior CUSTOMER reschedules are fewer than the
   * snapshotted free count AND `now()` is at or before the snapshotted cutoff.
   * The count reads the booking's own history rows by actor, so a professional's
   * reschedule never consumes the customer's free one.
   *
   * Otherwise the reschedule is evaluated under the cancellation policy. A
   * consequence that would carry money is refused — its meaning is not ratified
   * — and a zero consequence needs the customer's explicit confirmation. Both
   * refusals throw before anything is written; `null` means free.
   */
  private async governedRescheduleConsequence(
    manager: EntityManager,
    booking: BookingEntity,
    governance: Extract<BookingRescheduleGovernance, { governed: true }>,
    options: RescheduleOptions,
  ): Promise<BookingRescheduleFacts | null> {
    const [row]: Array<{ event_instant: string; cutoff_instant: string; timely: boolean; prior: number }> = await manager.query(
      `SELECT to_char(now() AT TIME ZONE 'UTC', ${ISO_MICROS}) AS event_instant,
              to_char((b.slot_start - make_interval(hours => $2::int)) AT TIME ZONE 'UTC', ${ISO_MICROS}) AS cutoff_instant,
              now() <= b.slot_start - make_interval(hours => $2::int) AS timely,
              (SELECT count(*)::int
                 FROM booking.booking_history h
                WHERE h.booking_id = b.id AND h.event = 'rescheduled' AND h.actor_type = 'customer') AS prior
         FROM booking.bookings b
        WHERE b.id = $1`,
      [booking.id, governance.cutoffHours],
    );

    const facts: BookingRescheduleFacts = {
      bookingId: booking.id,
      eventInstant: row.event_instant,
      cutoffInstant: row.cutoff_instant,
      timely: row.timely,
      wasConfirmed: booking.status === 'confirmed',
    };
    const prior = Number(row.prior);
    if (prior < governance.rescheduleFreeCount && facts.timely) return null;

    const retainedToman = this.rescheduleOutcome.consequenceRetainedToman(governance, facts);
    if (retainedToman > 0n) throw new RescheduleNotAllowedException('consequence_unavailable');
    if (options.acceptConsequence !== true) {
      throw new RescheduleConsequenceRequiredException({
        retainedToman: retainedToman.toString(),
        cutoffAt: facts.cutoffInstant,
        freeRemaining: Math.max(0, governance.rescheduleFreeCount - prior),
      });
    }
    return facts;
  }

  // ---------------------------------------------------------------------
  // Cancellation facts -- V3.3 #160 (`#42c`)
  // ---------------------------------------------------------------------

  /**
   * The database facts a cancellation decision is judged on, read on the
   * caller's transaction with the booking row held `FOR SHARE`.
   *
   * `null` when the booking does not exist or records no cancellation: a
   * `BookingCancelled` fact with no cancelled booking behind it has nothing to
   * decide, and no money moves on it.
   *
   * The caller passes the snapshotted cutoff (or `null` for an order without
   * terms), and the comparison `created_at <= slot_start − cutoff` happens here,
   * in SQL, against the cancelling transaction's own clock.
   */
  async cancellationFacts(
    manager: EntityManager,
    bookingId: string,
    cutoffHours: number | null,
  ): Promise<BookingCancellationFacts | null> {
    const rows: Array<{
      cancelled_by_actor_type: BookingActorType;
      from_status: BookingStatus | null;
      event_instant: string;
      cutoff_instant: string | null;
      timely: boolean | null;
    }> = await manager.query(
      `SELECT b.cancelled_by_actor_type,
              h.from_status,
              to_char(h.created_at AT TIME ZONE 'UTC', ${ISO_MICROS}) AS event_instant,
              CASE WHEN $2::int IS NULL THEN NULL
                   ELSE to_char((b.slot_start - make_interval(hours => $2::int)) AT TIME ZONE 'UTC', ${ISO_MICROS}) END AS cutoff_instant,
              CASE WHEN $2::int IS NULL THEN NULL
                   ELSE h.created_at <= b.slot_start - make_interval(hours => $2::int) END AS timely
         FROM booking.bookings b
         JOIN booking.booking_history h ON h.booking_id = b.id AND h.event = 'cancelled'
        WHERE b.id = $1 AND b.status = 'cancelled'
        ORDER BY h.id
        LIMIT 1
          FOR SHARE OF b`,
      [bookingId, cutoffHours],
    );
    const row = rows[0];
    if (!row || row.cancelled_by_actor_type === null) return null;
    return {
      cancelledByActorType: row.cancelled_by_actor_type,
      wasConfirmed: row.from_status === 'confirmed',
      eventInstant: row.event_instant,
      cutoffInstant: row.cutoff_instant,
      timely: row.timely,
    };
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

  // ---------------------------------------------------------------------
  // Resource assignment -- V3.3 #128 (`#110b`)
  // ---------------------------------------------------------------------

  /**
   * Resolves and writes this booking's resource assignment for the given
   * `(serviceId, deliveryLocationId, startAt, endAt)`, inside the caller's
   * transaction. Called from BOTH `createWithin` (first assignment) and
   * `reschedule` (reassignment to a new destination) -- there is at most
   * ONE assignment row per booking, ever (`UNIQUE(booking_id)`,
   * `BookingResourceAssignmentEntity`'s own docs), so this method always
   * decides INSERT vs UPDATE from whether a row already exists for
   * `bookingId`, never appends a second one.
   *
   * ## The three outcomes, and which is which
   *
   * `#131`'s `eligibleResourcesFor` distinguishes "no requirement to
   * resolve" (`null`) from "a requirement exists and is unmet" (`[]`) --
   * see that port's own contract. `null` means this booking needs no
   * assignment: any EXISTING row is released (the destination no longer
   * needs a resource), never deleted. `[]` throws the platform's existing
   * generic non-enumerating refusal, `SlotUnavailableException` --
   * `ADR-049` §6.5's precedent, reused rather than a second shape invented.
   * A non-empty array is the candidate set to select from.
   *
   * ## Lock-then-verify, one candidate at a time, in a fixed order
   *
   * The FIRST read is unlocked (a read never blocks) and only decides the
   * ORDER candidates are tried in -- ascending id, the same fixed order
   * every caller sorts to, so two transactions racing over an overlapping
   * pool always attempt locks in the same sequence and can never deadlock
   * against each other. Only the candidate actually being tried is locked,
   * via `lockResourceForAssignment` -- the same convention `business`'s
   * retire/close path uses on the other side of this exact race (see that
   * function's own documentation for why a lock is needed at all: a
   * resource can be retired, or gain/lose a requirement match, between an
   * unlocked read and this transaction's write). Once a candidate is
   * locked, this re-reads eligibility authoritatively before touching it:
   * if it retired in the gap, nothing that could still retire it can
   * proceed concurrently while we hold its lock, so the re-read is
   * conclusive. Candidates never reached by this loop are never locked --
   * the cost of a successful assignment is the cost of the ONE candidate
   * that worked, not the size of the eligible pool.
   *
   * ## Selection: try candidates in order, never guess, never abort early
   *
   * The GiST exclusion constraint -- not this method's ordering -- is what
   * actually prevents two bookings from occupying one resource at
   * overlapping times; ordering only decides WHICH free resource is offered
   * first when several qualify. An `INSERT`/`UPDATE` that collides raises
   * PostgreSQL `23P01` (or, defensively, `23505`) -- but ANY failed
   * statement marks the whole transaction aborted until a `ROLLBACK TO
   * SAVEPOINT`, so each attempt runs inside its own savepoint: a collision
   * rolls back only that attempt and leaves the surrounding transaction (the
   * booking row already inserted by the caller, included) perfectly usable
   * for the next candidate. Never surfaced as a 500. Only when every
   * candidate has been tried and none succeeded does this throw the generic
   * refusal, and by then nothing has been written.
   */
  private async syncResourceAssignment(
    manager: EntityManager,
    bookingId: string,
    serviceId: string | null,
    deliveryLocationId: string | null,
    startAt: Date,
    endAt: Date,
  ): Promise<void> {
    const existing = await manager.findOne(BookingResourceAssignmentEntity, { where: { bookingId } });

    const initialCandidates = await this.eligibleResources.eligibleResourcesFor(manager, serviceId, deliveryLocationId);

    if (initialCandidates === null) {
      if (existing && existing.status === 'active') {
        await manager.update(BookingResourceAssignmentEntity, { id: existing.id }, { status: 'released' });
        this.auditLog.log({ action: 'booking.resource_released', bookingId });
      }
      return;
    }

    if (initialCandidates.length === 0) {
      throw new SlotUnavailableException();
    }

    const sortedCandidateIds = [...initialCandidates].sort();
    for (const resourceId of sortedCandidateIds) {
      await lockResourceForAssignment(manager, resourceId);

      const authoritative = await this.eligibleResources.eligibleResourcesFor(manager, serviceId, deliveryLocationId);
      if (!authoritative || !authoritative.includes(resourceId)) {
        // Retired (or otherwise made ineligible) in the gap between the
        // unlocked read and this lock -- try the next candidate.
        continue;
      }

      await manager.query('SAVEPOINT sp_resource_assignment');
      try {
        if (existing) {
          await manager
            .createQueryBuilder()
            .update(BookingResourceAssignmentEntity)
            .set({ resourceId, startAt, endAt, status: 'active' })
            .where('id = :id', { id: existing.id })
            .execute();
        } else {
          await manager.insert(BookingResourceAssignmentEntity, {
            id: uuidv7(),
            bookingId,
            resourceId,
            startAt,
            endAt,
            status: 'active',
          });
        }
        await manager.query('RELEASE SAVEPOINT sp_resource_assignment');
        this.auditLog.log({
          action: existing ? 'booking.resource_reassigned' : 'booking.resource_assigned',
          bookingId,
        });
        return;
      } catch (err) {
        await manager.query('ROLLBACK TO SAVEPOINT sp_resource_assignment');
        if (!isResourceCollision(err)) throw err;
        // This candidate collided -- try the next one. Nothing was written.
      }
    }

    throw new SlotUnavailableException();
  }

  /**
   * Releases this booking's resource assignment, if it has one. Idempotent:
   * a booking with no assignment, or one already `released`, matches zero
   * rows and is a silent no-op -- the row is never deleted, so cancellation
   * history is never falsified.
   */
  private async releaseResourceAssignment(manager: EntityManager, bookingId: string): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(BookingResourceAssignmentEntity)
      .set({ status: 'released' })
      .where('booking_id = :bookingId AND status = :status', { bookingId, status: 'active' })
      .execute();
    if ((result.affected ?? 0) > 0) {
      this.auditLog.log({ action: 'booking.resource_released', bookingId });
    }
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

/**
 * Postgres `23P01` = exclusion_violation (the `ex_booking_resource_no_overlap`
 * GiST constraint), `23505` = unique_violation (defensively -- `#128`'s own
 * `UNIQUE(booking_id)` should never fire here, since `syncResourceAssignment`
 * always resolves INSERT vs UPDATE from an existing row, but a second cause
 * for "the database rejected this candidate" is treated identically to the
 * exclusion violation rather than escaping as a 500). The exact precedent
 * `availability.service.ts`'s `isOverlapViolation` already establishes for
 * the slot-overlap case (ADR-049 §6.5) -- not re-exported from there because
 * that module's function is private to a different exception mapping.
 */
function isResourceCollision(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '23P01' || code === '23505';
}
