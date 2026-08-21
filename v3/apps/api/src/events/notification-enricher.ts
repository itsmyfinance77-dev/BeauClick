import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProfessionalEntity } from '@beauclick/provider';
import { BookingService } from '@beauclick/booking';
import { TierService } from '@beauclick/loyalty';

export interface BookingNotificationDetails {
  professionalName: string;
  /** The APPOINTMENT time. Null when the booking or its slot can no longer be read. */
  startAt: Date | null;
}

/**
 * Fills in the display data a notification template needs but a domain event
 * does not carry.
 *
 * This lives in `apps/api` because it is a cross-domain read -- booking's slot
 * time plus provider's display name -- and the composition root is the one
 * tier permitted to do that (ADR-011). Neither notification-service nor
 * booking-service could implement it without depending on a domain it must
 * not know about.
 *
 * The alternative would have been to widen `BookingConfirmed`'s payload with
 * a `professionalName` and a `startAt`. That was rejected: an event payload
 * describes a FACT, and "the professional's current display name" is not part
 * of the fact that a booking was confirmed -- it is presentation data that
 * every other consumer would then carry, and that would go stale in the event
 * log the moment the professional renamed themselves.
 *
 * Every failure here degrades rather than throws. A notification that says
 * "متخصص" instead of a name is worth sending; a notification that was never
 * sent because a name lookup failed is not.
 */
@Injectable()
export class NotificationEnricher {
  /** Shown when the professional cannot be read. Deliberately generic rather than blank. */
  private static readonly FALLBACK_NAME = 'متخصص';

  constructor(
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    private readonly bookings: BookingService,
    private readonly tiers: TierService,
  ) {}

  /**
   * The tier's display name, from its slug.
   *
   * `LoyaltyTierChanged` carries `toTierSlug` -- a stable machine key -- and
   * deliberately not the name, for the same reason booking events carry ids:
   * a display name is presentation data that goes stale in an event log the
   * moment an admin renames the tier.
   *
   * Without this the customer was told "شما به سطح bronze رسیدید" -- the raw
   * slug, in the middle of a Persian sentence. Caught by reading the actual
   * notification the real stack produced during live QA.
   */
  async tierName(slug: string): Promise<string> {
    if (!slug) return '';
    try {
      const tiers = await this.tiers.activeTiers();
      return tiers.find((t) => t.slug === slug)?.name ?? slug;
    } catch {
      // The slug is a poor label but an honest one; failing the notification
      // outright over a lookup would be worse.
      return slug;
    }
  }

  async bookingDetails(bookingId: string, professionalId: string): Promise<BookingNotificationDetails> {
    const [professionalName, startAt] = await Promise.all([
      this.professionalName(professionalId),
      this.bookingStartAt(bookingId),
    ]);
    return { professionalName, startAt };
  }

  private async professionalName(professionalId: string): Promise<string> {
    if (!professionalId) return NotificationEnricher.FALLBACK_NAME;
    try {
      const professional = await this.professionals.findOne({
        where: { id: professionalId },
        select: { id: true, displayName: true },
      });
      return professional?.displayName || NotificationEnricher.FALLBACK_NAME;
    } catch {
      return NotificationEnricher.FALLBACK_NAME;
    }
  }

  private async bookingStartAt(bookingId: string): Promise<Date | null> {
    if (!bookingId) return null;
    try {
      const booking = await this.bookings.findById(bookingId);
      return booking?.slotStart ?? null;
    } catch {
      return null;
    }
  }
}
