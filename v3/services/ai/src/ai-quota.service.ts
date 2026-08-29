import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import { AI_DAILY_MESSAGE_QUOTA } from '@beauclick/ai-contract';

import { AI_CLOCK, AiClock, tehranCalendarDay, tehranDayResetsAt } from './ai-clock';
import { AiUsageDailyEntity } from './entities/ai.entities';

export interface AiQuotaOutcome {
  readonly allowed: boolean;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetsAt: Date;
}

/**
 * The daily quota (`V32-DEC-008`) — twenty accepted customer messages per user
 * per Tehran calendar day, enforced in PostgreSQL.
 *
 * ## Why this is not the HTTP throttler
 *
 * `BeauClickThrottlerGuard` is registered globally and still runs on these
 * routes. It is abuse control, and it is correct at what it does. It is NOT
 * what makes twenty mean twenty, for one structural reason: its storage is
 * in-memory per process, which is right at single-instance scale and silently
 * wrong the moment a second instance exists — the effective limit multiplies by
 * instance count. That topology question is `THROTTLE-STORE` and it is
 * unresolved. A PostgreSQL row is shared across every instance by construction,
 * so the correctness limit does not depend on an answer nobody has yet.
 *
 * ## Why the increment is one statement
 *
 * `GAP-04` records V2's campaign caps losing to a read-then-write race: read
 * 19, decide it is fine, write 20 — twice, concurrently, ending at 21.
 *
 * `consume` below is a single conditional
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < limit RETURNING`. The
 * `ON CONFLICT DO UPDATE` takes a row-level lock, so concurrent transactions
 * serialise on it; the `WHERE` is evaluated against the row as the winner left
 * it; and an empty `RETURNING` means the guard rejected the update. Twenty
 * concurrent submissions therefore produce exactly twenty rows and one refusal
 * per excess request, which is a mandatory test and is proved against real
 * PostgreSQL rather than pg-mem — pg-mem does not honour the isolation this
 * rests on.
 *
 * ## Why it runs in the caller's transaction
 *
 * The `EntityManager` argument is not a convenience. `consume` is called inside
 * the transaction that also inserts the customer's message, so the counter and
 * the message commit or roll back together. A version of this that opened its
 * own connection would let a message exist without having been counted, or a
 * count exist without a message — and the second is worse, because it spends a
 * customer's allowance on a request that failed.
 *
 * ## What is counted
 *
 * ACCEPTED customer messages only. A refused, invalid, unauthorized, or
 * injection-blocked request must not spend a user's allowance (ADR-030 T5):
 * otherwise anybody holding a token — including one stolen briefly — could
 * destroy that user's day with twenty junk requests, and a client bug would be
 * indistinguishable from an attack. Abuse of the refusal path is the HTTP
 * throttler's problem.
 *
 * The deterministic provider is counted too. Zero external cost is not a reason
 * to exempt a path: the retention and export obligations are identical
 * whichever provider answered, and a quota that only exists on the expensive
 * path is a quota nobody has tested.
 */
@Injectable()
export class AiQuotaService {
  constructor(
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    private readonly config: ConfigService,
  ) {}

  /**
   * The limit in force.
   *
   * `V32-DEC-008` fixes it at twenty and that is the default. It is readable
   * from configuration so a test can drive the boundary without sending twenty
   * requests per case — NOT so a deployment can quietly raise it. A change to
   * the real limit is a decision-register edit; this is a test seam, and saying
   * so here is cheaper than discovering the ambiguity later.
   */
  limit(): number {
    const configured = Number(this.config.get<string>('AI_DAILY_MESSAGE_QUOTA'));
    return Number.isInteger(configured) && configured > 0 ? configured : AI_DAILY_MESSAGE_QUOTA;
  }

  /** Today's Tehran calendar day, from the injected clock. */
  currentDay(): string {
    return tehranCalendarDay(this.clock.now());
  }

  /**
   * Reserves one message against today's allowance, atomically.
   *
   * Returns `allowed: false` with the current figures when the day is spent.
   * The caller aborts its transaction on that outcome, so nothing is written.
   *
   * `simulated` / `external` is honest provider accounting (`V32-DEC-008`),
   * incremented alongside the quota counter so an operator can see what actually
   * served without reading anybody's conversation (`V32-DEC-009`).
   */
  async consume(manager: EntityManager, userId: string, respondsExternally: boolean): Promise<AiQuotaOutcome> {
    const day = this.currentDay();
    const limit = this.limit();

    const rows: Array<{ accepted_messages: number }> = await manager.query(
      `INSERT INTO ai.usage_daily (user_id, usage_day, accepted_messages, simulated_replies, external_replies)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (user_id, usage_day) DO UPDATE
         SET accepted_messages = ai.usage_daily.accepted_messages + 1,
             simulated_replies = ai.usage_daily.simulated_replies + $3,
             external_replies  = ai.usage_daily.external_replies  + $4,
             updated_at        = now()
         -- The guard. Evaluated against the row as the previous transaction
         -- left it, because DO UPDATE holds the row lock. An empty RETURNING
         -- is the refusal.
         WHERE ai.usage_daily.accepted_messages < $5
       RETURNING accepted_messages`,
      [userId, day, respondsExternally ? 0 : 1, respondsExternally ? 1 : 0, limit],
    );

    if (rows.length === 0) {
      // The update was rejected by the guard. The stored count is at the limit,
      // by definition -- reading it back would be a second round trip to learn
      // something the guard already proved.
      return { allowed: false, limit, used: limit, remaining: 0, resetsAt: tehranDayResetsAt(day) };
    }

    const used = Number(rows[0].accepted_messages);
    return { allowed: true, limit, used, remaining: Math.max(0, limit - used), resetsAt: tehranDayResetsAt(day) };
  }

  /**
   * The read-only view, for showing a remaining count.
   *
   * Explicitly NOT what enforcement uses. A `peek` followed by a `consume` is
   * the read-then-write race this service exists to avoid, so the two are
   * separate methods with separate names and only one of them writes.
   */
  async peek(manager: EntityManager, userId: string): Promise<AiQuotaOutcome> {
    const day = this.currentDay();
    const limit = this.limit();
    const row = await manager.getRepository(AiUsageDailyEntity).findOne({ where: { userId, usageDay: day } });
    const used = row?.acceptedMessages ?? 0;
    return {
      allowed: used < limit,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: tehranDayResetsAt(day),
    };
  }
}
