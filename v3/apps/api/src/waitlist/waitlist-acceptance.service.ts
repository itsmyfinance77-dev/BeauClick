import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BookingEntity, BookingService, SlotUnavailableException } from '@beauclick/booking';
import { WaitlistService } from '@beauclick/waitlist';
import { OutboxRelay } from '@beauclick/events';

/**
 * The one place a waitlist offer becomes a real booking -- and the reason
 * it lives here rather than in waitlist-service itself. ADR-011 forbids
 * `services/waitlist` importing `services/booking`, yet accepting an offer
 * needs `BookingService`'s atomic slot claim inside the SAME transaction as
 * `WaitlistService`'s own state CAS. This is exactly `CheckoutService`'s
 * shape for booking+order, applied to waitlist+booking.
 *
 * GAP-26's invariant, proven here rather than merely asserted: the offer
 * bought this customer NOTHING but a head start on trying. `claimSlot()`'s
 * predicate does not know or care that this claim came from a waitlist
 * offer -- a faster direct customer can still win the slot in between, and
 * when that happens `BookingService.create()` throws the identical
 * `SlotUnavailableException` any other losing claim throws.
 */
@Injectable()
export class WaitlistAcceptanceService {
  private readonly logger = new Logger('WaitlistAcceptanceService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly bookings: BookingService,
    private readonly waitlist: WaitlistService,
    private readonly relay: OutboxRelay,
  ) {}

  async accept(entryId: string, customerId: string): Promise<BookingEntity> {
    try {
      const booking = await this.dataSource.transaction(async (manager) => {
        const entry = await this.waitlist.claimOfferForAcceptance(entryId, customerId, manager);

        // claimOfferForAcceptance() already verified offeredSlotId is set
        // (it is the CAS's own precondition for status='offered').
        const created = await this.bookings.create(
          {
            customerId,
            professionalId: entry.professionalId,
            slotId: entry.offeredSlotId as string,
            serviceId: entry.serviceId,
            idempotencyKey: `waitlist:${entry.id}`,
          },
          manager,
        );

        await this.waitlist.recordResultingBooking(entry.id, created.id, manager);
        return created;
      });

      await this.drainQuietly();
      return booking;
    } catch (err) {
      if (err instanceof SlotUnavailableException) {
        // The transaction above rolled back entirely -- including the CAS
        // to 'accepted' -- so the entry is back at 'offered' in the
        // database. It genuinely lost the race, though, so it does not
        // belong there: mark it terminal in a fresh, independent
        // transaction rather than leaving it looking claimable.
        await this.waitlist.markMissed(entryId);
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
