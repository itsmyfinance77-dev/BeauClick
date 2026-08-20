import { Inject, Injectable } from '@nestjs/common';
import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { SettlementBatchEntity } from './entities/settlement.entity';
import { LedgerService } from './ledger.service';
import { OutstandingOrder, PartySummary, SettlementService } from './settlement.service';
import { FINANCIAL_PARTY_RESOLVER, FinancialParty, FinancialPartyResolver } from './ports';

/**
 * The ONLY financial surface a normal session ever reaches.
 *
 * This is the GAP-05 fix as a type signature rather than a discipline.
 * **Every method takes a session user id and nothing else.** There is no
 * party argument, so there is no party argument to spoof, mistype, or
 * forget to validate. The party is resolved internally, from the caller's
 * own profile, through `FinancialPartyResolver`.
 *
 * Contrast with what V2 shipped and later had to patch:
 *
 *   party_receivable_net($party_type, $party_id)   <-- caller supplies identity
 *
 * That method was safe only because every real caller happened to resolve
 * its own identity first. Nothing on the class enforced it. V3 does not
 * expose that shape to session-scoped callers at all; the cross-party reads
 * that genuinely need it live on `FinancialAdminService`, behind a
 * capability, in a different class, so the dangerous shape is never one
 * typo away from the self-service one.
 *
 * `null` (never a fabricated zero) is returned when the caller is not a
 * seller at all, so a controller can distinguish "genuinely zero earnings"
 * from "not a party" without a second lookup of its own.
 */
@Injectable()
export class MyFinanceService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly settlements: SettlementService,
    @Inject(FINANCIAL_PARTY_RESOLVER) private readonly partyResolver: FinancialPartyResolver,
  ) {}

  private async party(sessionUserId: string): Promise<FinancialParty | null> {
    if (!sessionUserId) return null;
    return this.partyResolver.resolveForUser(sessionUserId);
  }

  async mySummary(sessionUserId: string): Promise<PartySummary | null> {
    const party = await this.party(sessionUserId);
    if (!party) return null;
    return this.settlements.partySummary(party.partyType, party.partyId);
  }

  async myOutstandingOrders(sessionUserId: string): Promise<OutstandingOrder[] | null> {
    const party = await this.party(sessionUserId);
    if (!party) return null;
    return this.settlements.outstandingOrdersForParty(party.partyType, party.partyId);
  }

  async mySettlements(sessionUserId: string): Promise<SettlementBatchEntity[] | null> {
    const party = await this.party(sessionUserId);
    if (!party) return null;
    return this.settlements.settlementsForParty(party.partyType, party.partyId);
  }

  /**
   * The caller's own ledger entries for one order.
   *
   * Filtered to the resolved party's own rows, so even a caller who somehow
   * learns another seller's order id sees nothing: the platform's commission
   * row and any other party's receivable row are both excluded here, not
   * merely hidden by the controller.
   */
  async myLedgerForOrder(sessionUserId: string, orderId: string): Promise<LedgerEntryEntity[] | null> {
    const party = await this.party(sessionUserId);
    if (!party) return null;
    const entries = await this.ledger.entriesForOrder(orderId);
    return entries.filter((e) => e.partyType === party.partyType && e.partyId === party.partyId);
  }
}
