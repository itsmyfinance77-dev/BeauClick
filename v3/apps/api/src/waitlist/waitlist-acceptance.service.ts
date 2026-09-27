import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { BookingIdempotencyKeyEntity, SlotTooShortForServiceException, SlotUnavailableException } from '@beauclick/booking';
import type { BookingOutcomeAcceptanceV1 } from '@beauclick/commercial-policy-contract';
import { OfferNotAvailableException, WaitlistEntryEntity, WaitlistService } from '@beauclick/waitlist';
import { OutboxRelay } from '@beauclick/events';

import { CheckoutResult, CheckoutService } from '../checkout/checkout.service';

export interface WaitlistAcceptanceInput {
  entryId: string;
  customerId: string;
  /** Client retry token (the `Idempotency-Key` header). Required: it is what makes a retry converge. */
  idempotencyKey: string;
  /** The exact disclosed policy/copy versions the customer ticked, or null (governed sellers refuse null). */
  acceptedPolicy: BookingOutcomeAcceptanceV1 | null;
  callbackBaseUrl: string;
}

/**
 * The one place a waitlist offer becomes a real booking -- and, since demo
 * remediation F-8, a real ORDER and PAYMENT too.
 *
 * ## What was wrong
 *
 * Acceptance used to call `BookingService.create()` directly: a `pending`
 * booking with a 15-minute hold and no order, no acceptance snapshot and no
 * payment intent -- nothing the customer could pay, so the hold simply lapsed
 * (measured on the demo: 0 orders, "در انتظار پرداخت" with no pay control).
 *
 * ## What it does now
 *
 * It goes THROUGH `CheckoutService.checkout`, exactly like any other booking,
 * with the offer CAS as the checkout's entitling `claim`:
 *   - `lock` (before the slot claim, same transaction): offered -> accepted,
 *     owned by this customer, offer not expired, for THIS slot;
 *   - `link` (after booking + order exist): record the resulting booking.
 * So the policy acceptance check, pricing, the order, the payment intent, the
 * hold/expiry, the callback and the late-capture refund are the ordinary
 * checkout's -- nothing here invents a financial primitive. A refusal anywhere
 * (governed seller without the current terms, slot lost, F-5 slot too short)
 * rolls back the CAS too.
 *
 * ## Idempotency
 *
 * The booking's key is derived from (entry, client key). A retry with the same
 * key finds the entry already `accepted` with a booking created under that
 * very key, so `lock` lets it through and checkout REPLAYS: the same booking,
 * the same order, no second intent. A different key on an accepted entry is
 * refused like any unavailable offer.
 *
 * GAP-26 unchanged: the offer bought a head start, not the slot -- a faster
 * direct customer can still win it, and then the entry becomes `missed`.
 */
@Injectable()
export class WaitlistAcceptanceService {
  private readonly logger = new Logger('WaitlistAcceptanceService');

  constructor(
    private readonly checkout: CheckoutService,
    private readonly waitlist: WaitlistService,
    private readonly relay: OutboxRelay,
  ) {}

  /** The booking idempotency key for (entry, client key): bounded length, never the raw client value. */
  static bookingKey(entryId: string, clientKey: string): string {
    return `wl:${entryId}:${createHash('sha256').update(clientKey).digest('hex').slice(0, 32)}`;
  }

  async accept(input: WaitlistAcceptanceInput): Promise<CheckoutResult> {
    const entry = await this.waitlist.findById(input.entryId);
    if (!entry || entry.customerId !== input.customerId || !entry.offeredSlotId) throw new OfferNotAvailableException();
    const slotId = entry.offeredSlotId;
    const key = WaitlistAcceptanceService.bookingKey(entry.id, input.idempotencyKey);
    let replay = false;

    try {
      const result = await this.checkout.checkout({
        customerId: input.customerId,
        professionalId: entry.professionalId,
        slotId,
        serviceId: entry.serviceId,
        idempotencyKey: key,
        callbackBaseUrl: input.callbackBaseUrl,
        acceptedPolicy: input.acceptedPolicy,
        claim: {
          lock: async (m: EntityManager) => {
            const current = await m.findOne(WaitlistEntryEntity, { where: { id: entry.id }, lock: { mode: 'pessimistic_write' } });
            if (current && current.status === 'accepted' && current.customerId === input.customerId && current.resultingBookingId) {
              // A retry of an acceptance that already committed: only with the SAME key.
              const same = await m.findOne(BookingIdempotencyKeyEntity, {
                where: { scope: 'booking.create', ownerId: input.customerId, key },
              });
              if (same && same.resultId === current.resultingBookingId) {
                replay = true;
                return;
              }
              throw new OfferNotAvailableException();
            }
            const claimed = await this.waitlist.claimOfferForAcceptance(entry.id, input.customerId, m);
            // The offer that was read is the offer being paid for.
            if (claimed.offeredSlotId !== slotId) throw new OfferNotAvailableException();
          },
          link: async (m: EntityManager, bookingId: string) => {
            if (replay) return;
            await this.waitlist.recordResultingBooking(entry.id, bookingId, m);
          },
        },
      });
      await this.drainQuietly();
      return result;
    } catch (err) {
      if (err instanceof SlotUnavailableException || err instanceof SlotTooShortForServiceException) {
        // The transaction rolled back entirely -- including the CAS -- so the
        // entry is back at 'offered'. It cannot be booked, so it does not
        // belong there: mark it terminal in a fresh transaction (unchanged
        // behaviour for a lost race; F-5's matcher prevents the too-short case,
        // this covers an offer made before that rule existed).
        await this.waitlist.markMissed(entry.id);
        await this.drainQuietly();
      }
      throw err;
    }
  }

  private async drainQuietly(): Promise<void> {
    try {
      await this.relay.drain();
    } catch (err) {
      this.logger.warn(`Post-commit outbox drain failed; the periodic sweep will retry: ${String(err)}`);
    }
  }
}
