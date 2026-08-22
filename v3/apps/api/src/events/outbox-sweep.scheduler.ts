import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay } from '@beauclick/events';
import { BookingService } from '@beauclick/booking';
import { WaitlistService } from '@beauclick/waitlist';

/**
 * Two periodic backstops, both deliberately backstops rather than mechanisms.
 *
 * The outbox sweep exists because the post-commit drain in CheckoutService
 * is a latency optimisation, not a guarantee: a process that dies between
 * commit and drain must still deliver the event. The sweep is what makes
 * at-least-once actually true.
 *
 * The hold-expiry sweep is likewise NOT how availability is freed --
 * the slot claim predicate already treats a lapsed hold as claimable in
 * real time, so a customer never waits on this timer. What the sweep adds
 * is the booking-side truth: moving an abandoned booking out of `pending`
 * so it stops counting against its customer's concurrent-hold cap.
 *
 * `setInterval` rather than `@nestjs/schedule`: adding a dependency to run
 * two timers would re-open the pnpm peer-duplication hazard Phase 1
 * documented, for no capability this needs.
 */
@Injectable()
export class OutboxSweepScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxSweepScheduler');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly relay: OutboxRelay,
    private readonly bookings: BookingService,
    private readonly waitlist: WaitlistService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (String(this.config.get('DISABLE_BACKGROUND_SWEEPS') ?? '').toLowerCase() === 'true') {
      this.logger.warn('Background sweeps are disabled by configuration (tests drive them explicitly).');
      return;
    }

    this.timers.push(this.every(this.intervalMs('OUTBOX_SWEEP_INTERVAL_MS', 5_000), () => this.sweepOutbox()));
    this.timers.push(this.every(this.intervalMs('HOLD_EXPIRY_SWEEP_INTERVAL_MS', 60_000), () => this.sweepHolds()));
    this.timers.push(
      this.every(this.intervalMs('WAITLIST_OFFER_EXPIRY_SWEEP_INTERVAL_MS', 60_000), () => this.sweepWaitlistOffers()),
    );
  }

  onApplicationShutdown(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private intervalMs(key: string, fallback: number): number {
    const raw = Number(this.config.get(key));
    return Number.isFinite(raw) && raw >= 1000 ? raw : fallback;
  }

  private every(ms: number, task: () => Promise<void>): NodeJS.Timeout {
    const timer = setInterval(() => {
      // A sweep failure is logged and retried on the next tick, never
      // propagated -- an unhandled rejection in a timer would take the
      // process down over work that is retryable by design.
      task().catch((err) => this.logger.error(`Sweep failed: ${String(err)}`));
    }, ms);
    // Deliberately unref'd: a pending timer must never be the reason a
    // process refuses to exit (this bit test suites before it was added).
    timer.unref?.();
    return timer;
  }

  private async sweepOutbox(): Promise<void> {
    const result = await this.relay.drain();
    if (result.dispatched > 0 || result.failed > 0) {
      this.logger.log(`Outbox sweep: ${result.dispatched} dispatched, ${result.failed} failed`);
    }
  }

  private async sweepHolds(): Promise<void> {
    const expired = await this.bookings.expireStaleHolds();
    if (expired > 0) this.logger.log(`Hold expiry sweep: ${expired} booking(s) expired`);
  }

  /**
   * The same "sweep is a backstop, not the mechanism" shape as the two
   * above: a waitlist offer's own `offerExpiresAt` already makes `accept()`
   * reject it in real time (`WaitlistService.claimOfferForAcceptance`), so
   * a customer is never protected by how recently this ran. What the sweep
   * adds is moving the entry out of `offered` and emitting `WaitlistExpired`
   * so `WaitlistMatcherHandler` re-offers the still-open slot to the next
   * candidate -- without it, an unanswered offer would sit forever and no
   * one else would ever get a turn at that slot.
   */
  private async sweepWaitlistOffers(): Promise<void> {
    const expired = await this.waitlist.expireStaleOffers();
    if (expired > 0) this.logger.log(`Waitlist offer expiry sweep: ${expired} offer(s) expired`);
  }
}
