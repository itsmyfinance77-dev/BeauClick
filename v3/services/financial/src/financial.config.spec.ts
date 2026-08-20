import { ConfigService } from '@nestjs/config';
import { MoneyError } from '@beauclick/money';
import { FinancialConfig } from './financial.config';

function config(values: Record<string, string> = {}): FinancialConfig {
  return new FinancialConfig({ get: (key: string) => values[key] } as unknown as ConfigService);
}

describe('FinancialConfig', () => {
  it('defaults to the provisional 15% carried from V2', () => {
    expect(config().commissionRateBp()).toBe(1500);
    expect(FinancialConfig.DEFAULT_COMMISSION_RATE_BP).toBe(1500);
  });

  it('honours a configured rate', () => {
    expect(config({ FINANCIAL_COMMISSION_RATE_BP: '1250' }).commissionRateBp()).toBe(1250);
  });

  it('supports a fractional percentage, which V2s integer-percent model could not express', () => {
    // 1234 bp = 12.34%.
    expect(config({ FINANCIAL_COMMISSION_RATE_BP: '1234' }).commissionRateBp()).toBe(1234);
  });

  it('accepts the boundaries', () => {
    expect(config({ FINANCIAL_COMMISSION_RATE_BP: '0' }).commissionRateBp()).toBe(0);
    expect(config({ FINANCIAL_COMMISSION_RATE_BP: '10000' }).commissionRateBp()).toBe(10_000);
  });

  it('THROWS on an out-of-range rate rather than clamping it', () => {
    // V2 clamped with max(0, min(100, rate)). Clamping means a fat-fingered
    // "150%" quietly becomes 100% and starts mis-splitting real money; a
    // throw makes it a loud failure instead.
    expect(() => config({ FINANCIAL_COMMISSION_RATE_BP: '10001' }).commissionRateBp()).toThrow(MoneyError);
    expect(() => config({ FINANCIAL_COMMISSION_RATE_BP: '-1' }).commissionRateBp()).toThrow(MoneyError);
  });

  it('falls back to the default for a non-integer or unparseable value', () => {
    expect(config({ FINANCIAL_COMMISSION_RATE_BP: 'abc' }).commissionRateBp()).toBe(1500);
    expect(config({ FINANCIAL_COMMISSION_RATE_BP: '15.5' }).commissionRateBp()).toBe(1500);
  });

  it('names the commission basis explicitly, so it can be captured per ledger row', () => {
    expect(config().basis()).toBe('net_customer_amount');
  });
});
