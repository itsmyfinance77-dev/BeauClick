import { Injectable } from '@nestjs/common';

/**
 * The monotonic clock and sleeper the invitation timing floor runs on --
 * V3.3 Story #109 (`#44c`), `V33-DEC-033` R3.
 *
 * ## Why a seam rather than `Date.now()` and `setTimeout` inline
 *
 * Two reasons, and the second is the one that matters.
 *
 * `Date.now()` is a **wall clock**. It moves when NTP corrects it, and it can go
 * backwards. A floor computed from it can be skipped entirely by a clock step,
 * which would silently remove the mitigation exactly once and leave no trace.
 * `process.hrtime.bigint()` is monotonic by contract.
 *
 * And a floor that cannot be observed cannot be tested. With this seam a
 * deterministic fake proves that **every** semantic path waits, including the
 * exception path, without a suite that sleeps for real.
 */
export interface StaffInviteClock {
  /** Milliseconds from an arbitrary but monotonic origin. Never a wall clock. */
  monotonicNowMs(): number;
  /** Resolves after `ms`. A no-op for `ms <= 0`. Never a busy wait. */
  sleep(ms: number): Promise<void>;
}

export const STAFF_INVITE_CLOCK = Symbol('BEAUCLICK_STAFF_INVITE_CLOCK');

/**
 * The floor every invitation response waits out, in milliseconds.
 *
 * ## How this number was chosen, and what it is not
 *
 * It is an **engineering parameter**, not a product policy value: no register
 * decision fixes it, nothing commercial depends on it, and changing it changes no
 * contract. `V33-DEC-033` R3 requires "a production-safe bounded value justified
 * from measured local distributions".
 *
 * It must exceed the slowest well-formed path, which is the known-eligible one:
 * an owner probe, a phone resolution, a membership insert, an outbox write and an
 * audit write, all in one transaction. Measured locally against real PostgreSQL
 * that path sits comfortably under 100 ms, and the negative paths under 30 ms;
 * 150 ms leaves headroom above the slow tail without making the surface feel
 * broken to a human, and bounds the cost of an enumeration attempt to roughly
 * six attempts per second per connection.
 *
 * ## What it is not
 *
 * It is **not** constant-time. A pathologically slow database could still push
 * the known path past the floor, and this is disclosed rather than glossed: the
 * story proves *measured comparable timing under a documented method*, never
 * cryptographic constant-time behaviour.
 */
export const STAFF_INVITE_MIN_RESPONSE_MS = 150;

/**
 * The real clock.
 *
 * `process.hrtime.bigint()` returns nanoseconds from a monotonic origin;
 * dividing by 1e6 in `Number` space is exact enough for a millisecond floor and
 * avoids carrying BigInt through the call site.
 */
@Injectable()
export class SystemStaffInviteClock implements StaffInviteClock {
  monotonicNowMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
