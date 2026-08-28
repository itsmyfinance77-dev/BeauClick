import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Every number here is provisional (`GAP-10`), and every one is
 * environment-tunable rather than compiled in -- the same treatment loyalty's
 * and booking's policy numbers get, and for the same reason: a business
 * decision that has not been made must be VISIBLE as unmade, not silently
 * settled by whoever typed the constant.
 */
@Injectable()
export class PrivacyConfig {
  constructor(private readonly config: ConfigService) {}

  private num(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * The erasure grace window (`GAP-21`), in hours.
   *
   * 168 hours -- seven days -- is V2's own figure and is the placeholder here
   * too. It is long enough that somebody who deleted their account at 2am can
   * change their mind after a night's sleep and a working week, and short
   * enough that "I asked to be deleted" does not mean "in a month, maybe".
   *
   * **This is a business decision that has not been made** (roadmap §12). It
   * is recorded as one rather than presented as settled.
   */
  get erasureGraceHours(): number {
    return this.num('PRIVACY_ERASURE_GRACE_HOURS', 168);
  }

  /**
   * How long a generated export stays downloadable, in hours.
   *
   * Bounded on purpose and bounded SHORT: a complete personal-data export
   * sitting in the database indefinitely is a standing breach liability whose
   * only justification is convenience. 72 hours is enough to notice the
   * notification, sign in, and download.
   */
  get exportTtlHours(): number {
    return this.num('PRIVACY_EXPORT_TTL_HOURS', 72);
  }

  /** How often the sweep looks for due erasures and expired exports. */
  get sweepIntervalMs(): number {
    return this.num('PRIVACY_SWEEP_INTERVAL_MS', 60_000);
  }

  /**
   * How long a request may sit in `processing` before the sweep treats it as
   * abandoned and reclaims it.
   *
   * The sweep claims a request with a status CAS and then does real work. If
   * the process dies mid-generation the row is stuck in `processing` forever
   * and the subject's export never arrives -- with nothing reporting an error,
   * because from the database's point of view somebody is working on it.
   */
  get stalledProcessingMinutes(): number {
    return this.num('PRIVACY_STALLED_PROCESSING_MINUTES', 15);
  }
}
