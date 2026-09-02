import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AiConversationService } from '@beauclick/ai';

/**
 * The AI domain's two background sweeps.
 *
 * Its own scheduler rather than two more entries on `Phase3SweepScheduler`,
 * because that class injects search, notification, loyalty, and analytics —
 * adding AI to it would make a composition that wants the assistant drag in
 * four unrelated domains, and a composition that omits one of them unable to
 * schedule the AI sweeps at all.
 *
 * `setInterval` rather than `@nestjs/schedule`, matching every other sweep in
 * this codebase: a scheduling framework for two intervals carries more surface
 * than the problem has.
 *
 * ## Neither sweep is what the guarantee rests on
 *
 * This is the important thing to know before reading the cadences below.
 *
 * `AiConversationService.closeIfStale` applies the 24-hour rule on every read
 * and every message, from the same injected clock, so a conversation is closed
 * the moment anybody touches it past the horizon — whether or not this timer has
 * run. The sweep exists so that `status` is also true for anybody reading the
 * table directly, including the retention sweep, which measures from
 * `last_activity_at` and does not depend on closure having happened.
 *
 * That matters because `DISABLE_BACKGROUND_SWEEPS=true` exists and every test
 * suite sets it. If the 24-hour bound lived only here, it would be a claim about
 * this timer's uptime rather than about the product — and it would be untested,
 * because the suites that prove it run with the timer off.
 *
 * ## Cadences
 *
 * **Inactivity, hourly.** The horizon is 24 hours; sweeping every hour means a
 * conversation's `status` is at most an hour stale, which is far below any
 * resolution a customer or an operator perceives. Sweeping faster would burn
 * queries to fix a column nothing is currently reading.
 *
 * **Retention, every six hours.** The boundary is 30 days. A conversation
 * destroyed a few hours after its thirtieth day is compliant; one destroyed
 * EARLY is data loss, and nothing here rounds down. Six hours is also slow
 * enough that a large first run cannot coincide with itself.
 *
 * Every job is wrapped so a throw can never kill the timer — an unhandled
 * rejection inside a `setInterval` callback terminates the process under Node's
 * default policy, which would make one bad row take the whole API down.
 */
@Injectable()
export class AiSweepScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AiSweep');
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly conversations: AiConversationService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('DISABLE_BACKGROUND_SWEEPS') === 'true') {
      this.logger.log('AI background sweeps disabled by configuration');
      return;
    }

    this.schedule('ai-inactivity', this.intervalMs('AI_INACTIVITY_SWEEP_INTERVAL_MS', 3_600_000), async () => {
      const closed = await this.conversations.sweepInactive();
      if (closed > 0) this.logger.log(`Closed ${closed} inactive AI conversation(s)`);
    });

    this.schedule('ai-retention', this.intervalMs('AI_RETENTION_SWEEP_INTERVAL_MS', 21_600_000), async () => {
      const destroyed = await this.conversations.sweepRetention();
      // Logged at `log` rather than `debug`, unlike most sweeps: this one
      // DESTROYS customer data, and a permanent deletion that leaves no
      // operational trace is a deletion nobody can later account for. The count
      // is all that is recorded -- never an id, never a body.
      if (destroyed > 0) this.logger.log(`Destroyed ${destroyed} AI conversation(s) past the retention boundary`);
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
    // A floor of one second: a misconfigured `0` would busy-loop the event loop
    // and be extremely hard to diagnose from the symptom.
    return Number.isFinite(raw) && raw >= 1000 ? raw : fallback;
  }
}
