import type { BadgeTone } from '@/components/kit';

/**
 * How the finance workspace names what the server sends.
 *
 * Three tables, each keyed by a server enum that `finance-labels.spec.ts` reads
 * from source — `LEDGER_ENTRY_TYPES`, `SETTLEMENT_KINDS`,
 * `FINANCE_ACCESS_MODES` — so a value the server adds cannot reach a Persian
 * receipt as an English key, and an entry the server has dropped cannot linger
 * here. The ledger row used to be a two-way ternary (`commission` → «کارمزد
 * پلتفرم», anything else → «سهم شما»), which would have labelled an unknown
 * entry type as the seller's own share of the money.
 */
export const LEDGER_ENTRY_LABEL: Record<string, string> = {
  commission: 'کارمزد پلتفرم',
  receivable: 'سهم شما',
};

/** For an entry type this client has never heard of: never the raw key, and never a guess at whose money it is. */
export const UNKNOWN_LEDGER_ENTRY_LABEL = 'ردیف دفتر مالی';

export function ledgerEntryLabel(entryType: string): string {
  return LEDGER_ENTRY_LABEL[entryType] ?? UNKNOWN_LEDGER_ENTRY_LABEL;
}

export const SETTLEMENT_KIND_LABEL: Record<string, string> = {
  settlement: 'تسویه',
  reversal: 'برگشت تسویه',
};

export const SETTLEMENT_KIND_TONE: Record<string, BadgeTone> = {
  settlement: 'success',
  reversal: 'error',
};

export const UNKNOWN_SETTLEMENT_KIND_LABEL = 'نامشخص';

export function settlementKindLabel(kind: string): string {
  return SETTLEMENT_KIND_LABEL[kind] ?? UNKNOWN_SETTLEMENT_KIND_LABEL;
}

export function settlementKindTone(kind: string): BadgeTone {
  return SETTLEMENT_KIND_TONE[kind] ?? 'neutral';
}

export const WORKSPACE_TYPE_LABEL: Record<'professional' | 'business', string> = {
  professional: 'تخصصی',
  business: 'کسب‌وکار',
};

export const ACCESS_MODE_LABEL: Record<string, string> = {
  owner: 'دسترسیِ مالکانه',
  finance_read: 'دسترسیِ فقط‌خواندنیِ واگذارشده',
};
