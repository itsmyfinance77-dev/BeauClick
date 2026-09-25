import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ProfessionalEntity } from '@beauclick/provider';
import { BusinessEntity } from '@beauclick/business';
import { BookingService } from '@beauclick/booking';
import { TierService } from '@beauclick/loyalty';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
 * ## Degrade where a degraded value is honest; refuse where it would be a lie
 *
 * The original rule here was "every failure degrades rather than throws", and
 * half of it is right: a notification that says "متخصص" instead of a name is
 * worth sending, and one never sent because a NAME lookup failed is not. A
 * generic label is an honest answer to "who is this" whether the row is missing
 * or the query failed.
 *
 * The other half was wrong, and #313 is what it cost. Every lookup caught its
 * exceptions and returned the same `null` that means "this row does not exist",
 * so **one value carried two meanings** and the callers -- reasoning correctly
 * about the meaning they were told about -- turned an infrastructure failure
 * into a positive claim:
 *
 *  * `bookingStartAt` returning null made a confirmation notification state the
 *    appointment was "for" the instant we processed the confirmation. The
 *    caller's own comment names that harm exactly: "confidently wrong in a way
 *    they would act on".
 *  * `sellerUserId` returning null made every settlement notification drop
 *    silently, on a path whose docblock promised null meant "the party's own
 *    profile is gone".
 *
 * Note the asymmetry that makes this worse than it sounds: a deleted row is
 * rare and permanent, while a failing query is an operational condition that
 * can affect EVERY event while it lasts. The branch written for the rare case
 * was the one that ran in the common failure.
 *
 * So: a lookup that cannot say whether the row exists **throws**. Only a lookup
 * that genuinely found nothing returns null. `NotificationDispatchHandler`
 * catches, logs and drops, which keeps the invariant that actually matters --
 * a notification failure never blocks the fact that caused it -- while making
 * the drop a recorded event rather than an invisible one.
 */
@Injectable()
export class NotificationEnricher {
  private readonly logger = new Logger('NotificationEnricher');

  /** Shown when the professional cannot be read. Deliberately generic rather than blank. */
  private static readonly FALLBACK_NAME = 'متخصص';

  constructor(
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    @InjectRepository(BusinessEntity) private readonly businesses: Repository<BusinessEntity>,
    private readonly bookings: BookingService,
    private readonly tiers: TierService,
  ) {}

  /**
   * The identity user id who should hear about money moving for this
   * financial party -- resolved the SAME way `ProviderBackedFinancialPartyResolver`
   * resolves a party FROM a user, just inverted (party -> user, since a
   * settlement notification starts from the party financial-service already
   * recorded).
   *
   * Null means exactly one thing: **the party's own row is gone** (a deleted
   * profile), or the party type is one nobody can be notified for. The caller
   * drops the notification on null and says so, which is correct for that.
   *
   * A query that FAILS throws instead of returning null (#313). It used to
   * return null, which made a persistent database fault drop every settlement
   * notification -- money moved and nobody was told -- with no log, no retry
   * and no dead-letter row, indistinguishable from the deliberate drop. A
   * settlement notification is still a courtesy and still never worth failing
   * a financial fact's ingestion over; `NotificationDispatchHandler` is what
   * guarantees that, by catching and logging, rather than this method by
   * pretending the row was missing.
   */
  async sellerUserId(partyType: string, partyId: string): Promise<string | null> {
    if (partyType === 'business') {
      const business = await this.businesses.findOne({ where: { id: partyId, deletedAt: IsNull() }, select: { ownerId: true } });
      return business?.ownerId ?? null;
    }
    if (partyType === 'professional') {
      const professional = await this.professionals.findOne({
        where: { id: partyId, deletedAt: IsNull() },
        select: { ownerId: true },
      });
      return professional?.ownerId ?? null;
    }
    return null;
  }

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
    } catch (err) {
      // The slug is a poor label but an honest one; failing the notification
      // outright over a lookup would be worse. Logged rather than silent
      // (#313): a degradation nobody can see is indistinguishable from a tier
      // that really has no name, and this one is operational.
      this.logger.warn(`Tier name lookup failed for '${slug}', falling back to the slug: ${message(err)}`);
      return slug;
    }
  }

  /** Public wrapper for waitlist notifications, which need only the name -- no booking id exists yet. */
  async professionalDisplayName(professionalId: string): Promise<string> {
    return this.professionalName(professionalId);
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
    } catch (err) {
      // Kept degrading, deliberately: "متخصص" is an honest answer to "who is
      // this" whether the row is missing or the read failed, so unlike the
      // date it costs the reader nothing. Logged so the operational case is
      // still visible (#313).
      this.logger.warn(
        `Professional name lookup failed for '${professionalId}', falling back to a generic label: ${message(err)}`,
      );
      return NotificationEnricher.FALLBACK_NAME;
    }
  }

  /**
   * The appointment instant, or null when the booking genuinely cannot be
   * found any more.
   *
   * No catch (#313). Every caller of `bookingDetails` substitutes an event
   * instant -- `confirmedAt`, `cancelledAt`, `declaredAt` -- when this is null,
   * and that substitution is a **factual claim about when the appointment is**.
   * It is defensible for a booking whose row is genuinely gone; it is a lie
   * when the query simply failed, and the customer acts on the date they are
   * given. A dropped notification is recoverable. A wrong date in a delivered
   * one is not.
   */
  private async bookingStartAt(bookingId: string): Promise<Date | null> {
    if (!bookingId) return null;
    const booking = await this.bookings.findById(bookingId);
    return booking?.slotStart ?? null;
  }
}
