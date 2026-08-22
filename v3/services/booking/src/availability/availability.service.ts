import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, MoreThan, Repository } from 'typeorm';
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
  ) {}

  async createSlot(professionalId: string, input: CreateSlotInput): Promise<AvailabilitySlotEntity> {
    this.assertValidRange(input.startAt, input.endAt);

    if (input.startAt.getTime() < Date.now()) {
      throw new SlotInPastException();
    }

    if (await this.overlaps(professionalId, input.startAt, input.endAt)) {
      throw new SlotOverlapsException();
    }

    const entity = this.slots.create({
      id: uuidv7(),
      professionalId,
      serviceId: input.serviceId ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      status: 'open',
      heldUntil: null,
      heldByBookingId: null,
    });

    try {
      const saved = await this.slots.save(entity);
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
          this.slots.create({
            id: uuidv7(),
            professionalId,
            serviceId: input.serviceId ?? null,
            startAt: new Date(slotStartMs),
            endAt: new Date(slotStartMs + slotMinutes * 60_000),
            status: 'open',
            heldUntil: null,
            heldByBookingId: null,
          }),
        );
      }
    }

    if (candidates.length === 0) {
      return { created: 0, skipped: 0 };
    }

    const result = await this.slots
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
  private async overlaps(professionalId: string, startAt: Date, endAt: Date): Promise<boolean> {
    const conflict = await this.slots.findOne({
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
