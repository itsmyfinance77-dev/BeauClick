import { Logger } from '@nestjs/common';
import { NotificationEnricher } from './notification-enricher';

/**
 * A failed lookup must not become a positive claim -- #313.
 *
 * The enricher used to catch every exception and return the same `null` that
 * means "this row does not exist". One value carried two meanings, and the
 * callers -- reasoning correctly about the meaning they had been told about --
 * turned a database fault into a confirmation notification stating an
 * appointment date that was not the appointment, and into a settlement
 * notification that was never sent and never recorded.
 *
 * These tests pin the distinction itself: **thrown means thrown, and only a
 * genuine miss returns null.** They are deliberately written against each
 * lookup's two outcomes rather than against one happy path, because the whole
 * defect was that the two outcomes had been made indistinguishable.
 */

const BOOM = new Error('connection terminated');

/** Only the members the enricher actually uses; anything else would be pretence. */
function enricherWith(overrides: {
  professionals?: { findOne: jest.Mock };
  businesses?: { findOne: jest.Mock };
  bookings?: { findById: jest.Mock };
  tiers?: { activeTiers: jest.Mock };
}) {
  const professionals = overrides.professionals ?? { findOne: jest.fn().mockResolvedValue(null) };
  const businesses = overrides.businesses ?? { findOne: jest.fn().mockResolvedValue(null) };
  const bookings = overrides.bookings ?? { findById: jest.fn().mockResolvedValue(null) };
  const tiers = overrides.tiers ?? { activeTiers: jest.fn().mockResolvedValue([]) };
  return new NotificationEnricher(
    professionals as never,
    businesses as never,
    bookings as never,
    tiers as never,
  );
}

describe('a lookup that cannot answer throws rather than reporting absence', () => {
  describe('bookingStartAt, via bookingDetails', () => {
    it('propagates a failed booking read instead of reporting no appointment', async () => {
      const enricher = enricherWith({ bookings: { findById: jest.fn().mockRejectedValue(BOOM) } });

      // The assertion that matters. A resolved `{ startAt: null }` here is
      // exactly what made `date: formatFullJalaliDate(details.startAt ?? new
      // Date(p.confirmedAt))` tell a customer their booking was confirmed
      // "for" the instant we processed it.
      await expect(enricher.bookingDetails('b1', 'p1')).rejects.toThrow('connection terminated');
    });

    it('still reports null for a booking that genuinely is not there', async () => {
      const enricher = enricherWith({ bookings: { findById: jest.fn().mockResolvedValue(null) } });

      // The caller's substitution of the event instant is defensible HERE and
      // only here, which is why this direction is kept rather than also thrown.
      await expect(enricher.bookingDetails('b1', 'p1')).resolves.toMatchObject({ startAt: null });
    });

    it('returns the slot start when the booking is readable', async () => {
      const slotStart = new Date('2026-03-21T09:30:00.000Z');
      const enricher = enricherWith({ bookings: { findById: jest.fn().mockResolvedValue({ slotStart }) } });

      await expect(enricher.bookingDetails('b1', 'p1')).resolves.toMatchObject({ startAt: slotStart });
    });
  });

  describe('sellerUserId', () => {
    it('propagates a failed business read instead of reporting a deleted profile', async () => {
      const enricher = enricherWith({ businesses: { findOne: jest.fn().mockRejectedValue(BOOM) } });

      // Resolving null here is what dropped every settlement notification --
      // money moved, nobody told, nothing logged -- on a path whose docblock
      // promised null meant the party's own row was gone.
      await expect(enricher.sellerUserId('business', 'party-1')).rejects.toThrow('connection terminated');
    });

    it('propagates a failed professional read too', async () => {
      const enricher = enricherWith({ professionals: { findOne: jest.fn().mockRejectedValue(BOOM) } });

      await expect(enricher.sellerUserId('professional', 'party-1')).rejects.toThrow('connection terminated');
    });

    it('still returns null for a party whose row really is gone', async () => {
      const enricher = enricherWith({ businesses: { findOne: jest.fn().mockResolvedValue(null) } });

      await expect(enricher.sellerUserId('business', 'party-1')).resolves.toBeNull();
    });

    it('returns null for a party type nobody can be notified for', async () => {
      await expect(enricherWith({}).sellerUserId('platform', 'party-1')).resolves.toBeNull();
    });

    it('returns the owner when the party is readable', async () => {
      const enricher = enricherWith({ businesses: { findOne: jest.fn().mockResolvedValue({ ownerId: 'u-9' }) } });

      await expect(enricher.sellerUserId('business', 'party-1')).resolves.toBe('u-9');
    });
  });
});

describe('a lookup whose degraded value is honest keeps degrading, but says so', () => {
  it('falls back to a generic professional name and logs the failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const enricher = enricherWith({
      professionals: { findOne: jest.fn().mockRejectedValue(BOOM) },
      bookings: { findById: jest.fn().mockResolvedValue({ slotStart: new Date() }) },
    });

    // Unlike a date, "متخصص" is an honest answer to "who is this" whether the
    // row is missing or the read failed -- so it costs the reader nothing and
    // is worth more than a dropped notification.
    await expect(enricher.bookingDetails('b1', 'p1')).resolves.toMatchObject({ professionalName: 'متخصص' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Professional name lookup failed'));
    warn.mockRestore();
  });

  it('falls back to the tier slug and logs the failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const enricher = enricherWith({ tiers: { activeTiers: jest.fn().mockRejectedValue(BOOM) } });

    await expect(enricher.tierName('bronze')).resolves.toBe('bronze');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Tier name lookup failed'));
    warn.mockRestore();
  });
});
