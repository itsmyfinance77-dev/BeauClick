import { Inject, Injectable } from '@nestjs/common';

import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import {
  WORKSPACE_REFERENCE_SECRET,
  WorkspaceParty,
  deriveWorkspaceReference,
  resolveWorkspaceReference,
  workspaceReferencesMatch,
} from '@beauclick/workspace-reference';

import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { SettlementBatchEntity } from './entities/settlement.entity';
import { FinanceWorkspaceSelectionRequiredException } from './finance.exceptions';
import { LedgerService } from './ledger.service';
import {
  AddressableFinancialParty,
  FINANCE_WORKSPACE_OWNER_RESOLVER,
  FinanceAccessMode,
  FinanceWorkspaceOwnerResolver,
  FinancialParty,
} from './ports';
import { OutstandingOrder, PartySummary, SettlementService } from './settlement.service';

/**
 * A seller's own finances, addressed by WORKSPACE — V3.3 #72, `V33-DEC-020`.
 *
 * ## The defect this class exists to remove
 *
 * `MyFinanceService` decides who may READ a financial record by asking whose
 * money it is. That question is answered by `FinancialPartyResolver`, whose
 * implementation follows an active `business_staff` affiliation — correct for
 * attribution (ADR-023 §3) and wrong for permission. Two defects followed from
 * the one boundary:
 *
 *  1. a dual owner was resolved business-first, so their professional
 *     receivables, settlements and ledger were reachable through no route;
 *  2. an affiliated staff professional read the EMPLOYING business's
 *     receivable, settlement, outstanding balance and ledger — colleagues' and
 *     the owner's earnings included.
 *
 * This class asks a different question, through a different port:
 * `FINANCE_WORKSPACE_OWNER_RESOLVER` returns the parties the caller OWNS, and
 * ownership never follows affiliation. Both defects disappear together, because
 * they were one.
 *
 * ## Two enumerations, because two families of routes ask two questions (#111)
 *
 * V3.3 #111 (`#44e`, ADR-049 §5.4) lets an explicit, live, business-scoped
 * `finance_read` grant reach a business's finance workspace READ-ONLY. That
 * widens exactly one thing: what the five WORKSPACE-AWARE routes may address,
 * which is `addressableWorkspaces` — `owned ∪ live-scoped-read`, each entry
 * carrying its access mode. The four SINGULAR routes still resolve by
 * ownership alone through `ownedWorkspaces` / `singularWorkspace`
 * (`V33-DEC-020` Ruling 7): a grant never makes an owner's legacy route answer
 * differently, and a grantee who owns nothing gets the same non-enumerating
 * refusal there that any non-seller gets. Affiliation on its own — `staff`,
 * `manager` — still contributes nothing to either enumeration.
 *
 * The reference primitive is untouched: a grantee's reference to business B is
 * `HMAC(secret, granteeUserId, B)`, a different value from the owner's, useless
 * in any other session, and it stops matching the moment the grant stops being
 * enumerated. Revocation therefore needs no mechanism here either.
 *
 * ## Ordering is decided HERE and decides nothing else
 *
 * Workspaces are sorted by `(partyType, partyId)`. Deterministic, so a client
 * gets a stable order and a test can compare a whole response — and sorted here
 * rather than inherited from the resolver, so changing the resolver cannot
 * silently reorder a seller's workspaces.
 *
 * Ordering never SELECTS a workspace. Every read names one by reference, which
 * is the whole point: `V33-DEC-020` forbids first-in-array, business-first,
 * professional-first and affiliation-derived selection alike.
 *
 * ## Nothing here logs
 *
 * There is no logger in this file. The MAC input behind a `workspaceRef`
 * contains the owner's user id and the raw party id, and a `workspaceRef` in a
 * log line or metric label would be a stable per-seller identifier attached to
 * every financial figure in the record.
 */
@Injectable()
export class FinanceWorkspaceService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly settlements: SettlementService,
    @Inject(FINANCE_WORKSPACE_OWNER_RESOLVER) private readonly owners: FinanceWorkspaceOwnerResolver,
    @Inject(WORKSPACE_REFERENCE_SECRET) private readonly secret: string,
  ) {}

  // ======================================================================
  // Ownership
  // ======================================================================

  /**
   * Every finance workspace this user owns, in the surface's own order.
   *
   * Ownership ONLY. An affiliated staff member gets their own professional
   * workspace and nothing else — their employer's workspace never appears here,
   * which is what actually stops them reading it. Empty for a caller who owns
   * none, and an empty collection is a truthful answer rather than a `404`.
   */
  async ownedWorkspaces(sessionUserId: string): Promise<FinancialParty[]> {
    if (!sessionUserId) return [];
    const parties = await this.owners.ownedWorkspacesFor(sessionUserId);
    return [...parties].sort(
      (left, right) => left.partyType.localeCompare(right.partyType) || left.partyId.localeCompare(right.partyId),
    );
  }

  /**
   * Every finance workspace this user may ADDRESS on the workspace-aware
   * routes, in the surface's own order — V3.3 #111.
   *
   * `owned ∪ live-scoped-read`. The port already returns each workspace once
   * with `owner` winning; that invariant is re-asserted here rather than
   * trusted, because a duplicate would mint two references for one party and a
   * `finance_read` entry for an owned party would understate the caller's own
   * authority. Sorted by `(partyType, partyId)` exactly as `ownedWorkspaces`,
   * so an owner's entries sit where they always did and a grantee's are stable.
   */
  async addressableWorkspaces(sessionUserId: string): Promise<AddressableFinancialParty[]> {
    if (!sessionUserId) return [];
    const parties = await this.owners.addressableWorkspacesFor(sessionUserId);

    const byParty = new Map<string, AddressableFinancialParty>();
    for (const party of parties) {
      const key = `${party.partyType}:${party.partyId}`;
      const existing = byParty.get(key);
      if (!existing || (existing.accessMode !== 'owner' && party.accessMode === 'owner')) byParty.set(key, party);
    }

    return [...byParty.values()].sort(
      (left, right) => left.partyType.localeCompare(right.partyType) || left.partyId.localeCompare(right.partyId),
    );
  }

  /**
   * The browser contract for `GET /me/finance/workspaces`: a reference, a type
   * and an access mode — never an id.
   */
  async workspacesFor(sessionUserId: string): Promise<FinanceWorkspaceEntry[]> {
    const parties = await this.addressableWorkspaces(sessionUserId);
    return parties.map((party) => ({
      workspaceRef: this.referenceFor(sessionUserId, party),
      workspaceType: party.partyType,
      accessMode: party.accessMode,
    }));
  }

  referenceFor(sessionUserId: string, party: FinancialParty): string {
    return deriveWorkspaceReference(this.secret, sessionUserId, party as WorkspaceParty);
  }

  /**
   * The comparison seam, as a METHOD so a test can spy on it.
   *
   * A module-level call compiles to a direct local reference that no spy can
   * observe, so a test claiming "the constant-time comparison ran" could only
   * assert the outcome — which a `===` would also satisfy.
   */
  matchesReference(candidate: string, supplied: string): boolean {
    return workspaceReferencesMatch(candidate, supplied);
  }

  /**
   * The one ADDRESSABLE workspace a reference names, right now, and how.
   *
   * Throws `NotFoundOrNotYoursException` for EVERY failure — malformed,
   * wrong-length, random, foreign, stale, no-longer-owned, never-granted,
   * revoked, and correctly-shaped-but-unmatched alike. One status, one code,
   * one message, one body, so nothing here can be used to learn whether a party
   * exists, whether somebody else owns it, whether a grant ever existed, or
   * whether a reference was correctly signed. Ownership failures and grant
   * failures are the SAME failure — a reference either matches one of the
   * live candidates or it does not — which is what makes them byte-identical
   * by construction rather than by a second `if` (#111).
   */
  async resolveAddressableWorkspace(sessionUserId: string, workspaceRef: string): Promise<AddressableFinancialParty> {
    const parties = await this.addressableWorkspaces(sessionUserId);
    const matched = resolveWorkspaceReference(
      this.secret,
      sessionUserId,
      parties as readonly (WorkspaceParty & { accessMode: FinanceAccessMode })[],
      workspaceRef,
      (candidate, supplied) => this.matchesReference(candidate, supplied),
    );

    if (!matched) throw new NotFoundOrNotYoursException();
    return matched as AddressableFinancialParty;
  }

  /**
   * The one OWNED workspace a reference names, right now.
   *
   * Kept for callers that must never accept a grant — there are none on the
   * read surface today, and that is the point: a future write-shaped finance
   * route that resolves through this method cannot be reached by a
   * `finance_read` holder, whatever else it forgets.
   */
  async resolveOwnedWorkspace(sessionUserId: string, workspaceRef: string): Promise<FinancialParty> {
    const parties = await this.ownedWorkspaces(sessionUserId);
    const matched = resolveWorkspaceReference(
      this.secret,
      sessionUserId,
      parties as readonly WorkspaceParty[],
      workspaceRef,
      (candidate, supplied) => this.matchesReference(candidate, supplied),
    );

    if (!matched) throw new NotFoundOrNotYoursException();
    return matched as FinancialParty;
  }

  /**
   * The party a LEGACY singular route answers about.
   *
   * Three outcomes, and none of them is a silent choice:
   *
   *  * owns exactly one — that workspace, so every independent professional and
   *    every business owner sees byte-for-byte what they saw before;
   *  * owns none — `null`, which the controller turns into the existing
   *    non-enumerating refusal;
   *  * owns more than one — a refusal naming the collection route.
   *
   * The third is the whole correction. Returning the first array element,
   * the business, the professional or the affiliation-derived party would each
   * be a different flavour of the same defect.
   */
  async singularWorkspace(sessionUserId: string): Promise<FinancialParty | null> {
    const parties = await this.ownedWorkspaces(sessionUserId);
    if (parties.length === 0) return null;
    if (parties.length > 1) throw new FinanceWorkspaceSelectionRequiredException();
    return parties[0];
  }

  // ======================================================================
  // Reads — every one scoped to ONE addressable party (owned, or finance_read)
  // ======================================================================

  async summaryFor(sessionUserId: string, workspaceRef: string): Promise<PartySummary> {
    const party = await this.resolveAddressableWorkspace(sessionUserId, workspaceRef);
    return this.settlements.partySummary(party.partyType, party.partyId);
  }

  async outstandingOrdersFor(sessionUserId: string, workspaceRef: string): Promise<OutstandingOrder[]> {
    const party = await this.resolveAddressableWorkspace(sessionUserId, workspaceRef);
    return this.settlements.outstandingOrdersForParty(party.partyType, party.partyId);
  }

  /**
   * One page of settlements, newest first.
   *
   * `ix_settlement_batches_party (party_type, party_id, id DESC)` is exactly
   * the covering index a keyset page on `id DESC` needs, so the pagination this
   * adds required no migration and no new index.
   */
  async settlementsFor(
    sessionUserId: string,
    workspaceRef: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: SettlementBatchEntity[]; nextCursor: string | null }> {
    const party = await this.resolveAddressableWorkspace(sessionUserId, workspaceRef);

    // BEFORE any row is read. A cursor is bound to the workspace that issued
    // it, so one lifted from another workspace's response is refused rather
    // than silently paging the wrong ledger.
    const after = decodeWorkspaceCursor(workspaceRef, options.cursor, (a, b) => this.matchesReference(a, b));

    const limit = boundedLimit(options.limit);
    const rows = await this.settlements.settlementPageForParty(party.partyType, party.partyId, after, limit + 1);

    const items = rows.slice(0, limit);
    // A full page is not evidence of a next page; one extra row is. Fetching
    // `limit + 1` and discarding it is what makes `nextCursor` honest.
    const nextCursor = rows.length > limit ? encodeWorkspaceCursor(workspaceRef, items[items.length - 1].id) : null;
    return { items, nextCursor };
  }

  /**
   * The caller's own ledger rows for one order, in this workspace.
   *
   * Both facts are checked: the workspace is owned, and the rows are the
   * workspace's. The party predicate is in the SQL — see
   * `LedgerService.entriesForOrderAndParty` — rather than a filter applied to
   * an already-loaded mix of every party's rows, which is what
   * `MyFinanceService.myLedgerForOrder` used to do and what `V33-DEC-020`
   * forbids.
   *
   * An order belonging to a different workspace returns an empty list, exactly
   * like an order that does not exist. A caller who somehow learns a foreign
   * order id learns nothing from asking.
   */
  async ledgerFor(sessionUserId: string, workspaceRef: string, orderId: string): Promise<LedgerEntryEntity[]> {
    const party = await this.resolveAddressableWorkspace(sessionUserId, workspaceRef);
    return this.ledger.entriesForOrderAndParty(orderId, party.partyType, party.partyId);
  }
}

// ---------------------------------------------------------------------------
// The browser contract
// ---------------------------------------------------------------------------

/**
 * One addressable finance workspace.
 *
 * `workspaceRef` is OPAQUE and server-issued. It is not an authorization token:
 * live ownership — or, since #111, a live `finance_read` grant — is re-verified
 * on every request, so it stops working when the party stops being owned, the
 * grant is revoked, the membership stops being `active`, the business is
 * deleted or the secret is rotated. `workspaceType` is a two-valued
 * classification a seller already knows about their own business, carrying no
 * identity. `accessMode` (#111, additive) says HOW this session reaches the
 * workspace — `owner` or `finance_read` — which the caller also already knows,
 * and which lets a client render the right surface without a second call.
 */
export interface FinanceWorkspaceEntry {
  workspaceRef: string;
  workspaceType: 'professional' | 'business';
  accessMode: FinanceAccessMode;
}

/** Default page size, and the ceiling a caller may ask for. Mirrors `PageQueryDto`. */
export const FINANCE_PAGE_SIZE_DEFAULT = 20;
export const FINANCE_PAGE_SIZE_MAX = 100;

function boundedLimit(requested?: number): number {
  if (requested === undefined) return FINANCE_PAGE_SIZE_DEFAULT;
  return Math.min(Math.max(1, Math.trunc(requested)), FINANCE_PAGE_SIZE_MAX);
}

/**
 * A cursor, bound to the workspace that issued it.
 *
 * ## Why the workspaceRef is inside the cursor
 *
 * A bare `lastId` cursor is portable between workspaces: a dual owner — or an
 * attacker who obtained one page of a response — could hand a professional
 * cursor to the business route and page a ledger the cursor was never issued
 * for. Carrying the issuing `workspaceRef` and comparing it, in constant time,
 * against the workspace actually being read makes that unrepresentable.
 *
 * It is NOT a secret and NOT a credential: it contains only the reference the
 * client already holds plus a row id it has already been shown. It is opaque
 * so that clients treat it as a handle rather than parsing it, and it is
 * checked before a single row is read.
 *
 * A cursor that does not decode, does not match, or carries a malformed id is
 * refused with the same `NotFoundOrNotYoursException` every other reference
 * failure produces — a distinct "bad cursor" error would tell a caller their
 * forged reference was otherwise well-formed.
 */
export function encodeWorkspaceCursor(workspaceRef: string, lastId: string): string {
  return Buffer.from(`${workspaceRef}.${lastId}`, 'utf8').toString('base64url');
}

export function decodeWorkspaceCursor(
  workspaceRef: string,
  cursor: string | undefined,
  compare: (a: string, b: string) => boolean,
): string | null {
  if (cursor === undefined || cursor === '') return null;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new NotFoundOrNotYoursException();
  }

  const separator = decoded.indexOf('.');
  if (separator <= 0) throw new NotFoundOrNotYoursException();

  const issuedFor = decoded.slice(0, separator);
  const lastId = decoded.slice(separator + 1);

  // Constant-time, and the same seam the reference match uses: the two are the
  // same kind of comparison and must not drift apart.
  if (!compare(issuedFor, workspaceRef)) throw new NotFoundOrNotYoursException();
  if (!/^[0-9a-fA-F-]{36}$/.test(lastId)) throw new NotFoundOrNotYoursException();

  return lastId;
}
