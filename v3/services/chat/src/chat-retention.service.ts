import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { CHAT_RETENTION_MONTHS } from '@beauclick/chat-contract';
import { logOperation } from '@beauclick/events';

import { CHAT_CLOCK, ChatClock, retentionCutoff } from './chat-clock';

/**
 * The 24-month retention sweep (`V32-DEC-013`).
 *
 * ## The conversation is the retention unit, not the message
 *
 * Sweeping individual messages would leave threads with holes in the middle — a
 * reply to a question nobody can see. That shape already exists for erasure, and
 * the placeholder is there to make it *rare*, not routine. So retention destroys
 * a whole conversation and cascades: participants, messages, reports, and their
 * anchors go with it.
 *
 * ## Hard delete, and there is nowhere to record a soft one
 *
 * `V32-DEC-013` sweeps by hard delete. There is no `deleted_at` anywhere in the
 * `chat` schema — asserted against `information_schema` by the suite — so a soft
 * delete has nowhere to live even if somebody wanted one. A flag would make the
 * retention claim false while looking like it made it true.
 *
 * ## What survives, and why that is not a contradiction
 *
 * A moderation decision written to `admin.admin_audit_log` survives, because the
 * application role cannot UPDATE or DELETE that table and no sweep touches it.
 * The report ROW is the working queue item and goes with its conversation; the
 * audit row is the permanent record of what a privileged person did. Those are
 * two different things and only one of them is chat's to retain.
 */
@Injectable()
export class ChatRetentionService {
  private readonly logger = new Logger('ChatRetention');

  constructor(
    private readonly dataSource: DataSource,
    @Inject(CHAT_CLOCK) private readonly clock: ChatClock,
    private readonly config: ConfigService,
  ) {}

  private get retentionMonths(): number {
    const configured = Number(this.config.get<string>('CHAT_RETENTION_MONTHS'));
    return Number.isInteger(configured) && configured > 0 ? configured : CHAT_RETENTION_MONTHS;
  }

  private get batchSize(): number {
    const configured = Number(this.config.get<string>('CHAT_RETENTION_BATCH_SIZE'));
    return Number.isInteger(configured) && configured > 0 ? configured : 500;
  }

  /**
   * Destroys conversations past the retention boundary, in one bounded batch.
   *
   * **Batched and `SKIP LOCKED`**, for two reasons that only show up at scale.
   * A first run on a large table would otherwise hold one transaction across
   * every expired row, taking locks the send path needs; and two sweep instances
   * would block on each other rather than dividing the work. Neither matters on
   * a small table, which is exactly why they are easy to leave out and expensive
   * to add later.
   *
   * Age is measured from `last_message_at`, falling back to `created_at` for a
   * conversation nobody ever wrote in — an abandoned empty thread should age out
   * on when it was made, not sit forever because its activity column is null.
   *
   * Returns how many were destroyed, so the caller can loop until a pass is
   * empty rather than guessing at a batch count.
   */
  async sweepOnce(): Promise<number> {
    const cutoff = retentionCutoff(this.clock.now(), this.retentionMonths);

    const result = await this.dataSource.query(
      `DELETE FROM chat.conversations
        WHERE id IN (
          SELECT id FROM chat.conversations
           WHERE COALESCE(last_message_at, created_at) < $1
           ORDER BY COALESCE(last_message_at, created_at)
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )`,
      [cutoff, this.batchSize],
    );

    const destroyed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (destroyed > 0) {
      // Logged at `log` rather than `debug`, unlike most sweeps: this one
      // DESTROYS customer data, and a permanent deletion that leaves no
      // operational trace is a deletion nobody can later account for. The count
      // is all that is recorded -- never an id, never a body.
      logOperation(this.logger, 'chat.sweep.retention', {
        destroyed,
        retentionMonths: this.retentionMonths,
      });
    }
    return destroyed;
  }

  /**
   * Sweeps until a pass comes back empty.
   *
   * Bounded by `maxBatches` so a scheduled run cannot become unbounded work: a
   * backlog is drained across several ticks rather than in one very long
   * transaction sequence.
   */
  async sweep(maxBatches = 20): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const destroyed = await this.sweepOnce();
      total += destroyed;
      if (destroyed === 0) break;
    }
    return total;
  }

  /**
   * Reaps throttle buckets nobody will read again.
   *
   * `chat.send_counters` grows one row per user per active minute and is pure
   * bookkeeping — the daily total only ever looks back 24 hours, so anything
   * older is dead weight. Kept for 48 to leave a margin for clock skew and for
   * a sweep that did not run.
   */
  async sweepSendCounters(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 48 * 3_600_000);
    const result = await this.dataSource.query(`DELETE FROM chat.send_counters WHERE window_start < $1`, [cutoff]);
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
  }
}
