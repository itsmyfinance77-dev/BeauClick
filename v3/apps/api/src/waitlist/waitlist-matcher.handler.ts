import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import { AvailabilitySlotEntity } from '@beauclick/booking';
import { WaitlistService } from '@beauclick/waitlist';

interface SlotReopenedPayload extends Record<string, unknown> {
  professionalId: string;
  slotId: string;
}

/**
 * Reacts to every event that means "this professional's slot might be open
 * again" -- a real cancellation/expiry, or the waitlist's own decline/expiry
 * freeing up an offer it was holding a place for. Constructed once per
 * event type (mirroring `BookingSignalSearchHandler`'s pattern in Phase 3,
 * manually `new`'d in the composition root factory with already-injected
 * collaborators -- not resolved by Nest's own DI), since all four share the
 * identical reaction.
 *
 * Deliberately NOT a consumer of a `SlotOpened` event -- see
 * `waitlist.events.ts`'s docblock for why that event does not exist.
 */
export class WaitlistMatcherHandler implements DomainEventHandler<SlotReopenedPayload> {
  private readonly logger = new Logger('WaitlistMatcher');

  constructor(
    readonly eventType: string,
    private readonly waitlist: WaitlistService,
    private readonly slots: Repository<AvailabilitySlotEntity>,
  ) {}

  async handle(envelope: EventEnvelope<SlotReopenedPayload>): Promise<void> {
    const { professionalId, slotId } = envelope.payload;

    // Best-effort freshness check, not a correctness requirement: by the
    // time this handler runs the slot may already have been re-claimed by a
    // faster direct customer. Skipping a stale slot here just avoids an
    // offer nobody could ever accept; `WaitlistAcceptanceService` is what
    // actually enforces the invariant if this check's answer is already out
    // of date by the time a customer tries to accept.
    const slot = await this.slots.findOne({ where: { id: slotId } });
    if (!slot || slot.status !== 'open') return;

    const offered = await this.waitlist.offerNextFor(professionalId, slotId, slot.serviceId);
    if (offered) {
      this.logger.log(`Offered slot ${slotId} (professional ${professionalId}) to waitlist entry ${offered.id}`);
    }
  }
}
