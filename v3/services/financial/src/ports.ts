/**
 * financial-service's outbound port for party identity.
 *
 * This is the GAP-05 fix, expressed structurally.
 *
 * V2's `LedgerService::party_receivable_net($party_type, $party_id)` took
 * the party as caller-supplied arguments. Isolation between professionals
 * existed only because every real caller happened to resolve its own party
 * correctly first -- nothing on the class stopped a future caller passing
 * someone else's id and getting their financial data back. V2 eventually
 * added `receivable_net_for_current_session()` alongside it.
 *
 * V3 does not offer the unsafe shape at all on the session-facing surface.
 * The public read API takes a SESSION USER ID and resolves the party through
 * this port internally. There is no argument a caller could get wrong or
 * spoof, because there is no party argument.
 *
 * Cross-party reads still exist -- an operator genuinely needs them -- but
 * they live on a separate, capability-gated admin service, so the dangerous
 * shape is never one typo away from the self-service one.
 */
export interface FinancialParty {
  partyType: 'professional' | 'business';
  partyId: string;
}

export interface FinancialPartyResolver {
  /** The party this user IS, resolved from their own profile. Null when they are not a seller at all. */
  resolveForUser(userId: string): Promise<FinancialParty | null>;
}

export const FINANCIAL_PARTY_RESOLVER = Symbol('BEAUCLICK_FINANCIAL_PARTY_RESOLVER');

/** The dedicated, INSERT-only DataSource financial-service uses. See ADR-017. */
export const FINANCIAL_DATA_SOURCE = Symbol('BEAUCLICK_FINANCIAL_DATA_SOURCE');
