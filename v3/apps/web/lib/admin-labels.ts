/**
 * How the admin screens name what the server sends.
 *
 * Each table is keyed by a server enum that `admin-labels.spec.ts` reads from
 * source, so a value the server adds cannot reach an operator's screen as an
 * English key, and a value the server has dropped cannot linger here.
 */

/** The seller party types a settlement can be recorded against (`FUND_POSTING_SELLER_PARTY_TYPES`). */
export const PARTY_TYPE_LABEL: Record<string, string> = {
  professional: 'متخصص',
  business: 'کسب‌وکار',
};

/** For a party type this client has never heard of: never the raw key. */
export const UNKNOWN_PARTY_TYPE_LABEL = 'طرف حساب';

export function partyTypeLabel(partyType: string): string {
  return PARTY_TYPE_LABEL[partyType] ?? UNKNOWN_PARTY_TYPE_LABEL;
}
