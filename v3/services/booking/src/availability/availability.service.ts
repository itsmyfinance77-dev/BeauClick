import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, LessThan, MoreThan, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AvailabilitySlotEntity, SlotStatus } from '../entities/availability-slot.entity';
import { BookingConfig } from '../booking.config';
import {
  InvalidSlotRangeException,
  SlotInPastException,
  SlotNotReleasableException,
  SlotOverlapsException,
} from '../booking.errors';
import { PLATFORM_TIMEZONE, isIsoDate, isIsoTime, localDateTimeToInstant, zonedWeekday } from './platform-time';
import { AuditLogger } from '@beauclick/events';
import { DELIVERY_LOCATION_DIRECTORY, DeliveryLocationDirectory } from '../ports';

export interface CreateSlotInput {
  startAt: Date;
  endAt: Date;
  serviceId?: string | null;
}

export interface BulkGenerateInput {
  /** 0 = Sunday .. 6 = Saturday, read in the platform timezone. */
  weekdays: number[];
  /** `HH:mm` local wall clock. */
  timeStart: string;
  timeEnd: string;
  slotMinutes: number;
  /** `YYYY-MM-DD` local dates, inclusive. */
  dateFrom: string;
  dateTo: string;
  serviceId?: string | null;
}

export interface BulkGenerateResult {
  created: number;
  skipped: number;
}

export interface AvailabilityWindow {
  from: Date;
  to: Date;
}

/**
 * Owns `booking.availability_slots` for everything EXCEPT the claim/release
 * transitions, which belong exclusively to `BookingService`.
 *
 * That split is load-bearing and inherited from V2: this class only ever
 * creates and deletes `open` rows and reads slot state. It never writes
 * `held`/`booked`, so there is exactly one code path in the system capable
 * of claiming a slot, and the concurrency guarantee lives entirely inside
 * it rather than being a property several classes must independently
 * uphold.
 */
@Injectable()
export class AvailabilityService {
  private readonly auditLog = new AuditLogger('availability');

  constructor(
    @InjectRepository(AvailabilitySlotEntity) private readonly slots: Repository<AvailabilitySlotEntity>,
    private readonly config: BookingConfig,
    /**
     * V3.3 #127 (`#127a`). Slot CREATION now runs in a transaction so the
     * delivery-location snapshot is read and written atomically; the read paths
     * below deliberately keep using the injected repository, because a read never
     * writes and needs neither a transaction nor a lock.
     */
    private readonly dataSource: DataSource,
    /**
     * V3.3 #127 (`#127a`). Where this professional currently delivers, answered
     * by the composition root because `booking` may not import `business`
     * (ADR-011). NOT `@Optional()`: a composition that forgets it must fail to
     * boot rather than silently stamping every new slot with no context.
     */
    @Inject(DELIVERY_LOCATION_DIRECTORY) private readonly deliveryLocations: DeliveryLocationDirectory,
  ) {}

  /**
   * One open slot.
   *
   * ## Why this became a transaction in #127a
   *
   * The delivery-location snapshot must be read and written atomically: if the
   * resolve happened outside the insert, an owner rebinding the membership in
   * between would produce a slot stamped with a branch that was already stale
   * when the row landed. Holding both in one transaction means the snapshot the
   * row carries is the binding that was live at the instant it was inserted --
   * and, because the owner's own rebinding holds `FOR UPDATE` on the membership,
   * the two linearise rather than interleave.
   *
   * The overlap pre-check moved onto the same manager for the same reason: a
   * check on a different connection is a check against a different snapshot. The
   * database's exclusion constraint remains the authority either way, which is
   * why the violation translation below is unchanged.
   */
  async createSlot(professionalId: string, input: CreateSlotInput): Promise<AvailabilitySlotEntity> {
    this.assertValidRange(input.startAt, input.endAt);

    if (input.startAt.getTime() < Date.now()) {
      throw new SlotInPastException();
    }

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        if (await this.overlaps(manager, professionalId, input.startAt, input.endAt)) {
          throw new SlotOverlapsException();
        }

        const deliveryLocationId = await this.deliveryLocations.deliveryLocationFor(manager, professionalId);

        const entity = manager.create(AvailabilitySlotEntity, {
          id: uuidv7(),
          professionalId,
          serviceId: input.serviceId ?? null,
          startAt: input.startAt,
          endAt: input.endAt,
          status: 'open' as SlotStatus,
          heldUntil: null,
          heldByBookingId: null,
          deliveryLocationId,
        });

        return manager.save(AvailabilitySlotEntity, entity);
      });

      // The operational log carries no delivery location: it is internal context,
      // never a field a reader of the log needs (`V33-DEC-035` R9).
      this.auditLog.log({ action: 'availability.slot_created', professionalId, slotId: saved.id });
      return saved;
    } catch (err) {
      // The database's own exclusion/unique constraint is the authority on
      // overlap, not the SELECT above -- two concurrent createSlot calls can
      // both pass that check. Translating the violation here keeps the
      // caller-visible behaviour identical whether the application check or
      // the database won.
      if (isOverlapViolation(err)) throw new SlotOverlapsException();
      throw err;
    }
  }

  /**
   * Materializes a weekly pattern into concrete rows.
   *
   * Idempotent by DATABASE constraint, not by a preceding SELECT: re-running
   * the same pattern to extend coverage relies on `UNIQUE(professional_id,
   * start_at)` and an ON CONFLICT DO NOTHING insert. V2 did this with a
   * per-slot `SELECT 1 ... LIMIT 1` inside the generation loop, which is
   * both an N+1 (one query per candidate slot -- 60 days x 16 slots = 960
   * round trips) and racy against a concurrent identical submission. One
   * bulk insert fixes both.
   */
  async bulkGenerate(professionalId: string, input: BulkGenerateInput): Promise<BulkGenerateResult> {
    const { dateFrom, dateTo, timeStart, timeEnd, slotMinutes } = input;

    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateFrom > dateTo) {
      throw new InvalidSlotRangeException('dateFrom/dateTo');
    }
    if (!isIsoTime(timeStart) || !isIsoTime(timeEnd) || timeStart >= timeEnd) {
      throw new InvalidSlotRangeException('timeStart/timeEnd');
    }
    if (!Number.isInteger(slotMinutes) || slotMinutes < this.config.minSlotMinutes || slotMinutes > this.config.maxSlotMinutes) {
      throw new InvalidSlotRangeException('slotMinutes');
    }

    const spanDays = (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000;
    if (spanDays > this.config.maxBulkGenerationDays) {
      throw new InvalidSlotRangeException('range exceeds the maximum bulk generation window');
    }

    const weekdays = Array.from(new Set(input.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)));
    if (weekdays.length === 0) {
      throw new InvalidSlotRangeException('weekdays');
    }

    const now = Date.now();

    return this.dataSource.transaction(async (manager) => {
      /*
       * Resolved ONCE for the whole command, before the generation loop.
       *
       * A resolve per candidate would be the N+1 this method's own docblock was
       * written to avoid -- 60 days x 16 slots is 960 round trips -- and worse, a
       * rebinding mid-loop would stamp one submission's slots with two different
       * branches. One command means one branch.
       */
      const deliveryLocationId = await this.deliveryLocations.deliveryLocationFor(manager, professionalId);
      const candidates = this.generateCandidates(manager, professionalId, input, spanDays, weekdays, now, deliveryLocationId);

      if (candidates.length === 0) {
        return { created: 0, skipped: 0 };
      }

      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(AvailabilitySlotEntity)
        .values(candidates)
        .orIgnore()
        .returning('id')
        .execute();

      const created = Array.isArray(result.raw) ? result.raw.length : 0;
      this.auditLog.log({
        action: 'availability.bulk_generated',
        professionalId,
        created,
        skipped: candidates.length - created,
      });
      return { created, skipped: candidates.length - created };
    });
  }

  /**
   * The concrete rows one weekly pattern materialises into.
   *
   * Extracted in #127a so `bulkGenerate` reads as "resolve the branch once, then
   * generate, then insert once" rather than hiding the single resolve above a
   * long loop. The generation rules are unchanged.
   */
  private generateCandidates(
    manager: EntityManager,
    professionalId: string,
    input: BulkGenerateInput,
    spanDays: number,
    weekdays: number[],
    now: number,
    deliveryLocationId: string | null,
  ): AvailabilitySlotEntity[] {
    const { dateFrom, timeStart, timeEnd, slotMinutes } = input;
    const candidates: AvailabilitySlotEntity[] = [];

    for (let dayOffset = 0; dayOffset <= spanDays; dayOffset++) {
      const isoDay = new Date(Date.parse(`${dateFrom}T00:00:00Z`) + dayOffset * 86_400_000).toISOString().slice(0, 10);
      const windowStart = localDateTimeToInstant(isoDay, timeStart, PLATFORM_TIMEZONE);
      const windowEnd = localDateTimeToInstant(isoDay, timeEnd, PLATFORM_TIMEZONE);

      if (!weekdays.includes(zonedWeekday(windowStart, PLATFORM_TIMEZONE))) continue;

      for (
        let slotStartMs = windowStart.getTime();
        slotStartMs + slotMinutes * 60_000 <= windowEnd.getTime();
        slotStartMs += slotMinutes * 60_000
      ) {
        // An already-past slot on the first day is silently skipped, not an
        // error -- a professional submitting "this week, 09:00-17:00" at
        // 11:00 on Monday means the rest of the week, not a rejection.
        if (slotStartMs < now) continue;

        candidates.push(
          manager.create(AvailabilitySlotEntity, {
            id: uuidv7(),
            professionalId,
            serviceId: input.serviceId ?? null,
            startAt: new Date(slotStartMs),
            endAt: new Date(slotStartMs + slotMinutes * 60_000),
            status: 'open' as SlotStatus,
            heldUntil: null,
            heldByBookingId: null,
            // The same branch on every candidate of this command.
            deliveryLocationId,
          }),
        );
      }
    }

    return candidates;
  }

  /** The professional's own view: every slot in the window, whatever its state. */
  async listForProfessional(professionalId: string, window: AvailabilityWindow): Promise<AvailabilitySlotEntity[]> {
    const { from, to } = this.clampWindow(window);
    return this.slots.find({
      where: { professionalId, startAt: Between(from, to) },
      order: { startAt: 'ASC' },
    });
  }

  /**
   * The customer-facing view: only slots a customer could actually claim
   * right now.
   *
   * "Claimable" deliberately includes a `held` slot whose hold has already
   * lapsed, matching the claim predicate exactly. Showing availability by a
   * different rule than the one that decides the claim is how a UI ends up
   * offering slots that always fail -- or hiding slots that would succeed
   * because a sweep has not run yet.
   */
  async listClaimableSlots(
    professionalId: string,
    window: AvailabilityWindow,
    serviceId?: string | null,
  ): Promise<AvailabilitySlotEntity[]> {
    const { from, to } = this.clampWindow(window);
    const qb = this.slots
      .createQueryBuilder('s')
      .where('s.professionalId = :professionalId', { professionalId })
      .andWhere('s.startAt >= :from', { from })
      .andWhere('s.startAt <= :to', { to })
      .andWhere('s.startAt > :now', { now: new Date() })
      .andWhere('(s.status = :open OR (s.status = :held AND s.heldUntil < :now2))', {
        open: 'open' satisfies SlotStatus,
        held: 'held' satisfies SlotStatus,
        now2: new Date(),
      })
      .orderBy('s.startAt', 'ASC')
      .limit(500);

    if (serviceId) {
      // A slot with no service is generic and offerable for any service.
      qb.andWhere('(s.serviceId IS NULL OR s.serviceId = :serviceId)', { serviceId });
    }

    return qb.getMany();
  }

  async findById(slotId: string): Promise<AvailabilitySlotEntity | null> {
    return this.slots.findOne({ where: { id: slotId } });
  }

  /**
   * Only an `open` slot may be deleted. A held or booked slot backs a real,
   * in-flight customer commitment and must be released through cancellation
   * -- deleting it would leave a booking pointing at nothing.
   */
  async deleteSlot(professionalId: string, slotId: string): Promise<void> {
    const result = await this.slots.delete({ id: slotId, professionalId, status: 'open' });
    if (!result.affected) {
      throw new SlotNotReleasableException();
    }
    this.auditLog.log({ action: 'availability.slot_deleted', professionalId, slotId });
  }

  private assertValidRange(startAt: Date, endAt: Date): void {
    if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) throw new InvalidSlotRangeException('startAt');
    if (!(endAt instanceof Date) || Number.isNaN(endAt.getTime())) throw new InvalidSlotRangeException('endAt');
    if (startAt.getTime() >= endAt.getTime()) throw new InvalidSlotRangeException('startAt must precede endAt');

    const minutes = (endAt.getTime() - startAt.getTime()) / 60_000;
    if (minutes < this.config.minSlotMinutes || minutes > this.config.maxSlotMinutes) {
      throw new InvalidSlotRangeException('slot duration');
    }
  }

  /** Half-open overlap: [aStart, aEnd) intersects [bStart, bEnd) iff aStart < bEnd AND aEnd > bStart. */
  /**
   * Takes the caller's manager (#127a) so the pre-check runs on the same snapshot
   * as the insert that follows it. The database's exclusion constraint remains
   * the authority on overlap; this only turns the common case into a clean domain
   * error instead of a constraint violation.
   */
  private async overlaps(
    manager: EntityManager,
    professionalId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<boolean> {
    const conflict = await manager.findOne(AvailabilitySlotEntity, {
      where: { professionalId, startAt: LessThan(endAt), endAt: MoreThan(startAt) },
    });
    return conflict !== null;
  }

  private clampWindow(window: AvailabilityWindow): AvailabilityWindow {
    const from = window.from;
    const maxTo = new Date(from.getTime() + this.config.maxAvailabilityWindowDays * 86_400_000);
    const to = window.to.getTime() > maxTo.getTime() ? maxTo : window.to;
    if (to.getTime() < from.getTime()) throw new InvalidSlotRangeException('window');
    return { from, to };
  }
}

/** Postgres 23P01 = exclusion_violation, 23505 = unique_violation. Both mean "the database rejected an overlapping/duplicate slot". */
function isOverlapViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '23P01' || code === '23505';
}
