import { Injectable } from '@nestjs/common';

import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { SettlementBatchEntity } from './entities/settlement.entity';
import { FinanceWorkspaceService } from './finance-workspace.service';
import { LedgerService } from './ledger.service';
import { OutstandingOrder, PartySummary, SettlementService } from './settlement.service';

/**
 * The LEGACY singular finance surface, corrected — V3.3 #72, `V33-DEC-020`.
 *
 * ## What this class was, and the bug that was in it
 *
 * It is the GAP-05 fix as a type signature: **every method takes a session user
 * id and nothing else**, so there is no party argument to spoof, mistype or
 * forget to validate. That part was right and is unchanged.
 *
 * What was wrong was WHICH question it asked to get the party. It used
 * `FinancialPartyResolver`, which answers "whose money is this?" and follows an
 * active `business_staff` affiliation — correct for attribution (ADR-023 §3)
 * and wrong for a read. Two defects came out of that one call:
 *
 *  1. a dual owner was resolved business-first, so their professional earnings
 *     were reachable through no route at all;
 *  2. an affiliated staff professional read the EMPLOYING business's whole
 *     financial position.
 *
 * It now asks `FinanceWorkspaceService.singularWorkspace`, which answers "which
 * workspaces does this user OWN?" and never follows affiliation.
 *
 * ## The behaviour that changed, stated plainly
 *
 *  * an independent professional or a business owner sees exactly what they saw
 *    before — one owned workspace, same figures, same response shape;
 *  * an affiliated staff professional now sees **their own** professional
 *    workspace, which may legitimately be empty or zero because their earnings
 *    genuinely belong to the business. `V33-DEC-020` accepts that outcome and
 *    forbids falling back to the employer's figures to avoid an empty screen;
 *  * a dual owner is refused with `finance_workspace_selection_required` and
 *    directed to the workspace-aware routes, because no singular answer exists
 *    that is not a silent choice.
 *
 * `null` (never a fabricated zero) still means "not a seller at all", so a
 * controller can distinguish genuinely-zero earnings from not-a-party without a
 * second lookup.
 *
 * ## `FinancialPartyResolver` is not gone
 *
 * It stays bound and stays correct for attribution — that is what decides which
 * party a new order's ledger rows are written for. This class simply stopped
 * using an attribution answer as an authorization answer.
 */
@Injectable()
export class MyFinanceService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly settlements: SettlementService,
    private readonly workspaces: FinanceWorkspaceService,
  ) {}

  async mySummary(sessionUserId: string): Promise<PartySummary | null> {
    const party = await this.workspaces.singularWorkspace(sessionUserId);
    if (!party) return null;
    return this.settlements.partySummary(party.partyType, party.partyId);
  }

  async myOutstandingOrders(sessionUserId: string): Promise<OutstandingOrder[] | null> {
    const party = await this.workspaces.singularWorkspace(sessionUserId);
    if (!party) return null;
    return this.settlements.outstandingOrdersForParty(party.partyType, party.partyId);
  }

  async mySettlements(sessionUserId: string): Promise<SettlementBatchEntity[] | null> {
    const party = await this.workspaces.singularWorkspace(sessionUserId);
    if (!party) return null;
    // Unbounded, deliberately: the legacy route's response shape is preserved
    // byte-for-byte, and adding a page envelope here would be the client break
    // `V33-DEC-020` set out to avoid. The workspace-aware route paginates.
    return this.settlements.settlementsForParty(party.partyType, party.partyId);
  }

  /**
   * The caller's own ledger entries for one order.
   *
   * The party predicate is now in the SQL. This used to load every row for the
   * order — the platform's commission row and any other party's receivable
   * included — and filter them out in JavaScript. The answer was right and the
   * shape was what `V33-DEC-020` forbids: a workspace must scope the query at
   * the predicate, not filter an already-loaded cross-party result.
   */
  async myLedgerForOrder(sessionUserId: string, orderId: string): Promise<LedgerEntryEntity[] | null> {
    const party = await this.workspaces.singularWorkspace(sessionUserId);
    if (!party) return null;
    return this.ledger.entriesForOrderAndParty(orderId, party.partyType, party.partyId);
  }
}
