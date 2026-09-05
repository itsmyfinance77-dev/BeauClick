import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import type { ZeroCollectibleConfirmationHook } from '@beauclick/commerce';

/**
 * The entitlement seam's binding for V3.3 `#41b` — ADR-044 §6,
 * `V33-DEC-023` Ruling 8.
 *
 * ## It does nothing, and that is the entire specification
 *
 * No row, no event, no external call, no audit fact. Story #58 consumes a
 * booking credit here; until then there is no entitlement to consume, and
 * inventing one would be #58's decision taken early by the wrong story.
 *
 * ## Why a no-op adapter rather than no hook at all
 *
 * Because the seam has to be *proved* mandatory while it is still cheap. An
 * entitlement effect that can be silently absent is the failure mode
 * `V33-DEC-023` Ruling 8 exists to prevent, and the only way to know a
 * dependency is genuinely required is for a composition without it to fail to
 * construct. That property is testable today, with a no-op behind the port, and
 * it is untestable later if the port is introduced together with the money.
 *
 * So this class is not scaffolding waiting to be filled in — it is the thing
 * that makes the boot-time guarantee real. #58 replaces the *binding* in
 * `domain-ports.module.ts` and touches no booking, commerce or payment code.
 *
 * ## Why it logs at debug and writes nothing
 *
 * A confirmation that consumed nothing is not an event worth an audit row: the
 * audit trail records what happened, and nothing happened. The debug line
 * exists so that an operator diagnosing a missing credit after #58 ships can
 * tell "the hook ran and did nothing" from "the hook never ran" — which is the
 * one question this class can usefully answer.
 */
@Injectable()
export class NoopZeroCollectibleConfirmationHook implements ZeroCollectibleConfirmationHook {
  private readonly logger = new Logger('ZeroCollectibleConfirmationHook');

  /**
   * `manager` is accepted and deliberately unused.
   *
   * It is part of the contract, not of this implementation: #58's replacement
   * must write inside the caller's transaction, and a port that did not carry
   * the manager would force that story to widen the interface — which is the
   * moment somebody reaches for a fresh connection instead and puts the credit
   * consumption outside the transaction that decides whether the booking exists.
   */
  async onZeroCollectibleConfirmation(_manager: EntityManager, bookingId: string): Promise<void> {
    this.logger.debug(`No entitlement consumption is bound yet; booking ${bookingId} confirmed with none. (#58)`);
  }
}
