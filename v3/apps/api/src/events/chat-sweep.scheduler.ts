import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChatRetentionService } from '@beauclick/chat';

/**
 * Chat's two background sweeps.
 *
 * Its own scheduler rather than two more entries on `Phase3SweepScheduler`, for
 * the reason `AiSweepScheduler` records: that class injects search,
 * notification, loyalty, and analytics, so adding chat to it would make a
 * composition that wants messaging drag in four unrelated domains.
 *
 * ## Cadences, and what they are not
 *
 * **Retention, every six hours.** The boundary is 24 months. A conversation
 * destroyed a few hours after its 24-month mark is compliant; one destroyed
 * EARLY is data loss, and nothing here rounds down. Six hours is also slow
 * enough that a large first run cannot coincide with itself.
 *
 * **Counter reaping, hourly.** `chat.send_counters` grows one row per user per
 * active minute and is pure bookkeeping.
 *
 * Unlike the AI inactivity sweep, neither of these is a rule the product depends
 * on being applied promptly: the send window and the eligibility check are
 * evaluated live on every send, so nothing about a customer's experience waits
 * for a timer. These sweeps only reclaim storage and keep the retention promise.
 *
 * Every job is wrapped so a throw can never kill the timer -- an unhandled
 * rejection inside a `setInterval` callback terminates the process under Node's
 * default policy.
 */
@Injectable()
export class ChatSweepScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ChatSweep');
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly retention: ChatRetentionService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('DISABLE_BACKGROUND_SWEEPS') === 'true') {
      this.logger.log('Chat background sweeps disabled by configuration');
      return;
    }

    this.schedule('chat-retention', this.intervalMs('CHAT_RETENTION_SWEEP_INTERVAL_MS', 21_600_000), async () => {
      const destroyed = await this.retention.sweep();
      // Logged at `log` rather than `debug`: this sweep DESTROYS customer data,
      // and a permanent deletion that leaves no operational trace is one nobody
      // can later account for. The count is all that is recorded -- never an id,
      // never a body.
      if (destroyed > 0) this.logger.log(`Destroyed ${destroyed} chat conversation(s) past the retention boundary`);
    });

    this.schedule('chat-counters', this.intervalMs('CHAT_COUNTER_SWEEP_INTERVAL_MS', 3_600_000), async () => {
      const reaped = await this.retention.sweepSendCounters();
      if (reaped > 0) this.logger.debug(`Reaped ${reaped} stale chat send counter(s)`);
    });
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  private schedule(name: string, intervalMs: number, job: () => Promise<void>): void {
    const timer = setInterval(() => {
      void job().catch((err) => {
        this.logger.error(`Sweep "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    // `unref()` so a pending timer never holds the process open at shutdown.
    timer.unref();
    this.timers.push(timer);
    this.logger.log(`Scheduled "${name}" every ${intervalMs}ms`);
  }

  private intervalMs(key: string, fallback: number): number {
    const raw = Number(this.config.get(key));
    // A floor of one second: a misconfigured `0` would busy-loop the event loop.
    return Number.isFinite(raw) && raw >= 1000 ? raw : fallback;
  }
}
