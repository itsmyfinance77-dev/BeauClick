import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { AI_CONSENT_CONTRACT_KEY } from '@beauclick/ai-contract';

import { AI_CLOCK, AiClock } from './ai-clock';
import { AiConsentEntity } from './entities/ai.entities';

export interface AiConsentStatus {
  readonly accepted: boolean;
  readonly contractKey: string;
  readonly acceptedAt: Date | null;
}

/**
 * The one-time recorded acceptance (`V32-DEC-006`).
 *
 * ## What this is, and the much larger thing it deliberately is not
 *
 * One row per customer, recording that they accepted a named disclosure before
 * their first assistant use. That is all. There is no version column, no
 * withdrawal column, no consent history, and no audit trail of changes, and
 * their absence is the decision rather than an omission: a versioned,
 * withdrawable consent system with an audit trail is scheduled at V3.3-E, and
 * building it here for one consumer would be building a platform mechanism for
 * a single caller.
 *
 * `contractKey` is the hedge that makes that safe. It names WHICH acceptance
 * was recorded, so acceptances gathered under the sandbox disclosure stay
 * distinguishable from ones gathered under the legally-reviewed copy that does
 * not exist yet (`V32-DEC-006` leaves that copy to legal review and does not
 * authorize it in this phase). Without it, the eventual approved wording would
 * arrive with no way to tell who had ever seen anything.
 *
 * ## Two rules on the write path
 *
 * **The owner is never supplied by the client.** `accept(userId)` is called with
 * the authenticated session's id and nothing else; no route accepts a consent
 * owner, and there is no parameter through which one could arrive.
 *
 * **Repeated acceptance is idempotent and does not move the timestamp.**
 * `ON CONFLICT DO NOTHING`, not `DO UPDATE`. A user who taps the button twice,
 * or whose client retries, must not have their original acceptance time
 * silently rewritten — that timestamp is the evidence, and evidence that moves
 * when somebody re-taps a button is not evidence.
 */
@Injectable()
export class AiConsentService {
  constructor(
    @InjectRepository(AiConsentEntity) private readonly consents: Repository<AiConsentEntity>,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
  ) {}

  async status(userId: string): Promise<AiConsentStatus> {
    const row = await this.consents.findOne({ where: { userId } });
    return {
      // Accepted means accepted UNDER THE CURRENT CONTRACT KEY. A stored row
      // naming a different key is a record of something else, and reporting it
      // as consent to this disclosure would be the exact claim `contractKey`
      // exists to keep honest.
      accepted: row !== null && row.contractKey === AI_CONSENT_CONTRACT_KEY,
      contractKey: AI_CONSENT_CONTRACT_KEY,
      acceptedAt: row?.acceptedAt ?? null,
    };
  }

  /**
   * Records the acceptance. Idempotent.
   *
   * Returns the resulting status rather than void, so the caller answers the
   * client from what is now stored rather than from what it just attempted —
   * a distinction that matters on the second, conflicting call.
   */
  async accept(userId: string): Promise<AiConsentStatus> {
    await this.consents
      .createQueryBuilder()
      .insert()
      .values({
        userId,
        contractKey: AI_CONSENT_CONTRACT_KEY,
        acceptedAt: this.clock.now(),
      })
      .orIgnore()
      .execute();

    return this.status(userId);
  }

  /**
   * The enforcement read, on the caller's transaction.
   *
   * Takes an `EntityManager` because the message-acceptance path checks consent
   * inside the same transaction that increments the quota and inserts the
   * message. Reading it on a separate connection would open a window in which
   * consent could be true when checked and absent when the row was written —
   * small, but free to close.
   */
  async hasAccepted(manager: EntityManager, userId: string): Promise<boolean> {
    const row = await manager.getRepository(AiConsentEntity).findOne({ where: { userId } });
    return row !== null && row.contractKey === AI_CONSENT_CONTRACT_KEY;
  }
}
