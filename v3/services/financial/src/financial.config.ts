import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertRateBasisPoints } from '@beauclick/money';

/**
 * The commission policy, in one place.
 *
 * The 15% default is carried over from V2's `CommissionConfig::
 * DEFAULT_RATE_PERCENT`, which V2 itself labelled NEEDS_BUSINESS_DECISION --
 * a real, working, overridable default so the system is deterministic and
 * testable today, never presented as final commercial policy. Restating
 * that here rather than quietly promoting a provisional number to a
 * decision.
 *
 * Expressed in BASIS POINTS rather than V2's integer percent, so a rate like
 * 12.5% is representable. 1500 bp = 15%.
 *
 * Every ledger row captures the rate it used at write time, so changing this
 * value affects only future transactions -- it can never retroactively alter
 * what a past refund reverses.
 */
@Injectable()
export class FinancialConfig {
  static readonly DEFAULT_COMMISSION_RATE_BP = 1500;
  static readonly BASIS = 'net_customer_amount';

  constructor(private readonly config: ConfigService) {}

  commissionRateBp(): number {
    const raw = Number(this.config.get('FINANCIAL_COMMISSION_RATE_BP'));
    const rate = Number.isInteger(raw) ? raw : FinancialConfig.DEFAULT_COMMISSION_RATE_BP;
    // Throws on an out-of-range configuration rather than clamping it: a
    // misconfigured commission rate must be a loud boot/first-use failure,
    // not a silently-corrected number that quietly mis-splits real money.
    return assertRateBasisPoints(rate, 'FINANCIAL_COMMISSION_RATE_BP');
  }

  basis(): string {
    return FinancialConfig.BASIS;
  }
}
