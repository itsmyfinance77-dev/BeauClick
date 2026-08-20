import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Every provisional business number booking-service depends on, in one
 * place, each overridable by environment configuration.
 *
 * These are engineering defaults carried forward from V2's own
 * clearly-labelled provisional constants (`BookingService::HOLD_MINUTES`,
 * `RescheduleService::DEFAULT_MAX_RESCHEDULES`), not commercial policy. The
 * discipline V2 established and this preserves: a provisional number lives
 * in exactly one named place and is overridable, never scattered as a magic
 * literal across services and controllers.
 */
@Injectable()
export class BookingConfig {
  constructor(private readonly config: ConfigService) {}

  private num(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * How long an unpaid booking holds its slot. 15 minutes is generous for
   * a redirect-based Iranian gateway round trip without meaningfully
   * starving availability -- V2's own reasoning, unchanged.
   */
  get holdMinutes(): number {
    return this.num('BOOKING_HOLD_MINUTES', 15);
  }

  /**
   * Abuse guard V2 added after a production-readiness audit: a scripted
   * account could otherwise accumulate holds (re-claiming each just before
   * it expires) and starve a popular professional's availability. A pure
   * request-rate limit does not stop this, because the attack is about
   * concurrent hold COUNT, not request rate.
   */
  get maxConcurrentHoldsPerCustomer(): number {
    return this.num('BOOKING_MAX_CONCURRENT_HOLDS', 5);
  }

  get maxReschedulesPerBooking(): number {
    return this.num('BOOKING_MAX_RESCHEDULES', 2);
  }

  get rescheduleMinHoursBefore(): number {
    return this.num('BOOKING_RESCHEDULE_MIN_HOURS_BEFORE', 6);
  }

  /** Bound on bulk slot generation, so a mistyped or adversarial range cannot generate unbounded rows in one request. */
  get maxBulkGenerationDays(): number {
    return this.num('BOOKING_MAX_BULK_DAYS', 60);
  }

  get minSlotMinutes(): number {
    return this.num('BOOKING_MIN_SLOT_MINUTES', 10);
  }

  get maxSlotMinutes(): number {
    return this.num('BOOKING_MAX_SLOT_MINUTES', 480);
  }

  /** Upper bound on any availability query window -- prevents an unbounded scan from a crafted date range. */
  get maxAvailabilityWindowDays(): number {
    return this.num('BOOKING_MAX_AVAILABILITY_WINDOW_DAYS', 62);
  }
}
