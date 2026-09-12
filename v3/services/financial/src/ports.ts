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

/**
 * financial-service's outbound port for workspace OWNERSHIP — V3.3 #72,
 * `V33-DEC-020`.
 *
 * ## Why this is not `FinancialPartyResolver`
 *
 * That port answers "whose money is this?" and its implementation follows an
 * active `business_staff` affiliation, because an affiliated professional's
 * earnings genuinely belong to the business (ADR-023 §3). Correct for
 * attribution, and it was the #72 defect the moment it was used to decide who
 * may READ: an employee reached the employer's whole financial position, and a
 * dual owner reached only whichever party the resolver preferred.
 *
 * This port answers a different question — **which seller parties does this
 * user OWN** — and it must never follow affiliation. Both ports keep existing,
 * bound to different adapters, because merging them would force one answer on
 * two questions that must be allowed to disagree.
 *
 * ## It returns a SET, and that is load-bearing
 *
 * `provider.professionals.owner_id` and `business.businesses.owner_id` are
 * independent unique indexes, so one user may own both. Returning one preferred
 * party is precisely the silent choice `V33-DEC-020` forbids, so the shape
 * here makes that choice unrepresentable rather than merely discouraged.
 *
 * Empty for a caller who owns none — never a fabricated party, and never one
 * they merely work for.
 */
export interface FinanceWorkspaceOwnerResolver {
  ownedWorkspacesFor(userId: string): Promise<FinancialParty[]>;

  /**
   * Every finance workspace this user may currently ADDRESS on the
   * workspace-aware routes — V3.3 #111 (`#44e`), ADR-049 §5.4.
   *
   * `owned ∪ live-scoped-read`: everything `ownedWorkspacesFor` returns, with
   * `accessMode: 'owner'`, plus each business for which the user holds a live
   * `finance_read` grant on an `active` membership, with `accessMode:
   * 'finance_read'`. A workspace reachable both ways appears **once**, as
   * `owner`. Never a party they merely work for: a `manager` or `staff` row
   * without a grant contributes nothing (`V33-DEC-020` Ruling 1, unweakened).
   *
   * Two methods rather than one widened method, on purpose. The four singular
   * routes resolve by OWNERSHIP (`V33-DEC-020` Ruling 7) and keep calling
   * `ownedWorkspacesFor`; if that method had been widened, an owner who later
   * received a grant on somebody else's business would start meeting a `409`
   * on `/me/finance/summary` — a behaviour change for an existing owner that
   * #111 forbids. The mode is on the result so `financial` can refuse a
   * write-shaped question for a `finance_read` party without a second lookup.
   *
   * Every fact behind the scoped half is re-read on every call. Nothing is
   * cached, nothing lives in a token claim, so a revoked grant is gone on the
   * next request.
   */
  addressableWorkspacesFor(userId: string): Promise<AddressableFinancialParty[]>;
}

/**
 * How a session reaches a finance workspace — V3.3 #111, ADR-049 §5.4.
 *
 * A closed, two-valued contract that is returned to the client on
 * `GET /me/finance/workspaces` and carries no identity. `owner` is live
 * ownership of the party; `finance_read` is a live, explicit, business-scoped
 * read grant. There is deliberately no third value: a finance WRITE authority
 * for a non-owner does not exist and is not representable here.
 */
export const FINANCE_ACCESS_MODES = ['owner', 'finance_read'] as const;
export type FinanceAccessMode = (typeof FINANCE_ACCESS_MODES)[number];

export interface AddressableFinancialParty extends FinancialParty {
  readonly accessMode: FinanceAccessMode;
}

export const FINANCE_WORKSPACE_OWNER_RESOLVER = Symbol('BEAUCLICK_FINANCE_WORKSPACE_OWNER_RESOLVER');

/** The dedicated, INSERT-only DataSource financial-service uses. See ADR-017. */
export const FINANCIAL_DATA_SOURCE = Symbol('BEAUCLICK_FINANCIAL_DATA_SOURCE');
