import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchIndexerService } from '@beauclick/search';
import { NotificationService } from '@beauclick/notification';
import { MembershipService } from '@beauclick/loyalty';
import { RollupService } from '@beauclick/analytics';

/**
 * The Phase 3 background sweeps.
 *
 * Four jobs, at deliberately different cadences, because they answer to
 * different kinds of urgency:
 *
 *   * **Search flush** (fast) -- how stale the marketplace is allowed to be
 *     after a provider edits their profile. Seconds matter here because the
 *     professional who just saved a change will look at their own listing.
 *   * **Notification retry** (medium) -- bounded by the backoff schedule
 *     anyway; sweeping faster than the shortest backoff just burns queries.
 *   * **Analytics rollup** (slow) -- nobody watches a dashboard update live,
 *     and the rollup recomputes an overlapping window so a late run loses
 *     nothing.
 *   * **Membership expiry** (slowest) -- a membership expiring a few minutes
 *     late has no user-visible consequence; expiring one EARLY would.
 *
 * `setInterval` rather than `@nestjs/schedule`, matching Phase 2's
 * `OutboxSweepScheduler`: adding a scheduling framework for four intervals
 * would be a dependency carrying more surface than the problem has.
 *
 * Every job is wrapped so a throw can never kill the timer. An unhandled
 * rejection inside a `setInterval` callback terminates the process under
 * Node's default policy -- meaning one bad notification could take the whole
 * API down, which is precisely the failure mode a background sweep must not
 * have.
 */
@Injectable()
export class Phase3SweepScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Phase3Sweep');
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly indexer: SearchIndexerService,
    private readonly notifications: NotificationService,
    private readonly memberships: MembershipService,
    private readonly rollups: RollupService,
  ) {}

  onApplicationBootstrap(): void {
    // Disabled by default under test: a sweep firing mid-assertion makes a
    // suite flaky in a way that is very hard to attribute, and every job here
    // is callable directly by the tests that actually exercise it.
    if (this.config.get('DISABLE_BACKGROUND_SWEEPS') === 'true') {
      this.logger.log('Background sweeps disabled by configuration');
      return;
    }

    this.schedule('search-flush', this.intervalMs('SEARCH_FLUSH_INTERVAL_MS', 5_000), async () => {
      const result = await this.indexer.flushDirty();
      if (result.indexed || result.deleted) {
        this.logger.debug(`Search flush: ${result.indexed} indexed, ${result.deleted} removed`);
      }
    });

    this.schedule('notification-retry', this.intervalMs('NOTIFICATION_RETRY_INTERVAL_MS', 30_000), async () => {
      const result = await this.notifications.retryDue();
      if (result.attempted) {
        this.logger.log(
          `Notification retry: ${result.attempted} attempted, ${result.sent} sent, ${result.deadLettered} dead-lettered`,
        );
      }
    });

    this.schedule('analytics-rollup', this.intervalMs('ANALYTICS_ROLLUP_INTERVAL_MS', 300_000), async () => {
      const result = await this.rollups.runRecent();
      this.logger.debug(`Analytics rollup: ${result.metrics} metrics, ${result.rows} rows`);
    });

    this.schedule('membership-expiry', this.intervalMs('MEMBERSHIP_EXPIRY_INTERVAL_MS', 900_000), async () => {
      const expired = await this.memberships.expireDue();
      if (expired) this.logger.log(`Expired ${expired} membership(s)`);
    });
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  private schedule(name: string, intervalMs: number, job: () => Promise<void>): void {
    const timer = setInterval(() => {
      void job().catch((err) => {
        // Caught, logged, and swallowed. See the class docblock: an escaping
        // rejection here would terminate the process.
        this.logger.error(`Sweep "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);

    // `unref()` so a pending timer never holds the process open at shutdown.
    // Phase 2's suite found exactly this class of hang with the financial
    // DataSource, and a timer is the other common cause.
    timer.unref();
    this.timers.push(timer);
    this.logger.log(`Scheduled "${name}" every ${intervalMs}ms`);
  }

  private intervalMs(key: string, fallback: number): number {
    const raw = Number(this.config.get(key));
    // A floor of one second: a misconfigured `0` would busy-loop the event
    // loop and be extremely hard to diagnose from the symptom.
    return Number.isFinite(raw) && raw >= 1000 ? raw : fallback;
  }
}
