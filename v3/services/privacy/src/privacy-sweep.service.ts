import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrivacyService } from './privacy.service';

/**
 * How an erasure is actually run.
 *
 * A seam, not indirection for its own sake: erasure has ONE step that cannot
 * live inside its transaction -- removing bytes from object storage, which has
 * no transaction to enlist in. That step needs `MediaService`, and privacy may
 * not import media (ADR-011). So the composition root binds an implementation
 * that brackets `executeErasure` with the byte purge, and this module keeps
 * knowing nothing about media.
 *
 * Unbound, the sweep calls `PrivacyService.executeErasure` directly. That is a
 * correct erasure with orphaned bytes left in the store -- which is what a
 * composition without media would mean, and it fails visibly (the bytes are
 * still there) rather than silently.
 */
export interface ErasureRunner {
  run(requestId: string, subjectUserId: string): Promise<void>;
}

export const ERASURE_RUNNER = Symbol('BEAUCLICK_ERASURE_RUNNER');

export interface PrivacySweepResult {
  reclaimed: number;
  exportsGenerated: number;
  exportsExpired: number;
  erasuresExecuted: number;
  erasuresFailed: number;
}

/**
 * The four background jobs the privacy lifecycle needs, in one pass.
 *
 * WHY GENERATION IS A SWEEP AND NOT AN EVENT CONSUMER. `DataExportRequested`
 * is published and consumed -- by notification and analytics -- but not by the
 * generator, and that split is deliberate. The outbox relay retries a failed
 * handler on its own schedule and gives up into a poison-message state; an
 * export that fails to generate must instead land in a `failed` status the
 * SUBJECT can see, and a request abandoned by a dying process must be picked
 * up again. Those are lifecycle concerns that belong to the row, not to the
 * delivery of a notification. Making the generator a second consumer would put
 * one lifecycle under two retry policies.
 *
 * ORDER MATTERS, and it is the order below:
 *
 *   1. reclaim stalled work first, so anything a dead process abandoned is
 *      back in `pending` before this pass looks for pending work;
 *   2. expire old exports before generating new ones, so a subject who asks
 *      again immediately is not competing for space with their own stale
 *      document;
 *   3. generate;
 *   4. erase last, because erasure is irreversible and everything above it is
 *      not -- if a pass is going to run out of time or die, it should do so
 *      before the step that cannot be undone.
 */
@Injectable()
export class PrivacySweepService {
  private readonly logger = new Logger('PrivacySweep');

  constructor(
    private readonly privacy: PrivacyService,
    @Optional() @Inject(ERASURE_RUNNER) private readonly runner: ErasureRunner | null = null,
  ) {}

  async runOnce(): Promise<PrivacySweepResult> {
    const result: PrivacySweepResult = {
      reclaimed: 0,
      exportsGenerated: 0,
      exportsExpired: 0,
      erasuresExecuted: 0,
      erasuresFailed: 0,
    };

    result.reclaimed = await this.privacy.reclaimStalled();
    result.exportsExpired = await this.privacy.expireStaleExports();

    for (const id of await this.privacy.pendingExports()) {
      if (await this.privacy.generateExport(id)) result.exportsGenerated += 1;
    }

    for (const due of await this.privacy.dueErasures()) {
      try {
        if (this.runner) {
          await this.runner.run(due.id, due.subjectUserId);
          result.erasuresExecuted += 1;
        } else {
          const outcome = await this.privacy.executeErasure(due.id);
          if (outcome) result.erasuresExecuted += 1;
        }
      } catch {
        // One subject's erasure failing must not stop the next subject's.
        // `executeErasure` has already marked the row `failed` with a stable
        // code and logged the cause; re-throwing here would abandon the rest
        // of the queue for a reason that is specific to one row.
        result.erasuresFailed += 1;
      }
    }

    if (result.reclaimed || result.exportsGenerated || result.exportsExpired || result.erasuresExecuted) {
      this.logger.log(
        `Privacy sweep: ${result.reclaimed} reclaimed, ${result.exportsGenerated} exports generated, ` +
          `${result.exportsExpired} expired, ${result.erasuresExecuted} erasures executed`,
      );
    }
    if (result.erasuresFailed) {
      this.logger.error(`Privacy sweep: ${result.erasuresFailed} erasure(s) failed`);
    }

    return result;
  }
}
