import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WaitlistConfig {
  constructor(private readonly config: ConfigService) {}

  private num(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * How long a customer has to accept an offer before the matcher moves on
   * to the next candidate. Shorter than `BOOKING_HOLD_MINUTES` on purpose --
   * an offer is not a hold (GAP-26), so there is no slot being reserved
   * while the customer decides; a short window just keeps a genuinely
   * available slot from sitting un-offered-to-anyone-else for long.
   */
  get offerWindowMinutes(): number {
    return this.num('WAITLIST_OFFER_WINDOW_MINUTES', 10);
  }

  /** Bound on how many waiting entries one professional's waitlist can hold -- prevents unbounded queue growth for a popular professional. */
  get maxEntriesPerProfessional(): number {
    return this.num('WAITLIST_MAX_ENTRIES_PER_PROFESSIONAL', 200);
  }
}
