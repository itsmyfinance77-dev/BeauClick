import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { RequireCapability } from '@beauclick/auth';
import { AdminAuditService, AuditAction } from '@beauclick/audit';

import { MyFinanceService } from './my-finance.service';
import { FinanceWorkspaceEntry, FinanceWorkspaceService } from './finance-workspace.service';
import { LedgerService } from './ledger.service';
import { SettlementService } from './settlement.service';
import { LedgerEntryEntity, LedgerPartyType } from './entities/ledger-entry.entity';
import { SettlementBatchEntity } from './entities/settlement.entity';
import { CreateSettlementDto, PartyQueryDto, ReverseSettlementDto } from './dto/settlement.dto';
import { EmptyFinanceQueryDto, SettlementPageQueryDto } from './dto/finance-workspace.dto';

/** The seller-safe projection of a settlement batch. One shape, both surfaces. */
function toSettlement(batch: SettlementBatchEntity) {
  return {
    id: batch.id,
    kind: batch.kind,
    amountToman: batch.amountToman,
    currency: batch.currency,
    method: batch.method,
    reference: batch.reference,
    createdAt: batch.createdAt.toISOString(),
  };
}

/** The seller-safe projection of a ledger entry. No party id, no order id, no actor. */
function toLedgerEntry(entry: LedgerEntryEntity) {
  return {
    id: entry.id,
    entryType: entry.entryType,
    amountToman: entry.amountToman,
    currency: entry.currency,
    commissionRateBp: entry.commissionRateBp,
    referenceType: entry.referenceType,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * A seller's own finances -- V3.3 #72, `V33-DEC-020`.
 *
 * ## Nine routes, in two families
 *
 * The five WORKSPACE-AWARE routes name one owned workspace by an opaque,
 * server-issued `workspaceRef`. They are what a dual owner uses to reach each of
 * their workspaces separately, and what makes "which workspace?" an explicit
 * question instead of a silent server-side choice.
 *
 * The four SINGULAR routes are kept, unchanged in shape, so existing clients
 * keep working. What changed inside them is which question decides the party:
 * ownership, not beneficiary. A caller who owns exactly one workspace sees
 * byte-for-byte what they saw before; one who owns none gets the same
 * non-enumerating refusal; one who owns two is refused with
 * `finance_workspace_selection_required` rather than being shown half their
 * position with nothing saying so.
 *
 * ## No route accepts a party
 *
 * There is no `userId`, `ownerId`, `professionalId`, `businessId` or `partyId`
 * in any path, query or body here. The caller comes from the session; the
 * workspace comes from a reference that is MATCHED against the parties the
 * caller currently owns, never used as a lookup key. Cross-party access is
 * therefore unrepresentable rather than merely refused -- the same construction
 * this controller has always claimed, now true for a dual owner as well.
 *
 * ## Why `/workspaces` cannot be swallowed by `:workspaceRef`
 *
 * Two independent reasons, and the suite asserts the outcome against the real
 * route table rather than trusting either:
 *
 *  * there is no bare `@Get(':workspaceRef')` anywhere on this controller, so a
 *    single-segment path has no dynamic route to match against at all;
 *  * `workspaces` is declared FIRST regardless, because Express matches in
 *    registration order and a future single-segment dynamic route added above it
 *    would shadow it silently.
 *
 * The singular routes below sit after the dynamic ones and are unaffected: each
 * has a different segment count from every dynamic path here.
 *
 * ## No capability, and that is a decision rather than an omission
 *
 * `V33-DEC-020` explicitly declines to enforce `bc_view_own_finance` here: the
 * capability exists and is granted to the `professional` and `business` roles in
 * the database, but account resolution normally assigns only `customer`, so
 * enforcing it would refuse legitimate sellers. Issue #75 owns that lifecycle.
 *
 * The security boundary on this controller is exactly three things: an
 * authenticated caller, live ownership, and workspace-scoped SQL predicates.
 * Nothing here claims capability enforcement or live revocation.
 */
@Controller('v1/me/finance')
export class MyFinanceController {
  constructor(
    private readonly finance: MyFinanceService,
    private readonly workspaces: FinanceWorkspaceService,
  ) {}

  // =========================================================================
  // Workspace-aware routes
  // =========================================================================

  /**
   * `GET /api/v1/me/finance/workspaces` -- every finance workspace the caller
   * currently OWNS.
   *
   * An empty array, never a `404`, for a caller who owns none: owning no seller
   * workspace is a legitimate state for an authenticated customer, and a `404`
   * would make "you are not a seller" indistinguishable from "no such route".
   *
   * An affiliated staff member gets their own professional workspace and nothing
   * else. Their employer's workspace never appears here, which is what actually
   * stops them reading it.
   */
  @Get('workspaces')
  async workspaceList(
    @CurrentUser() user: AuthenticatedUser,
    @Query() _query: EmptyFinanceQueryDto,
  ): Promise<{ items: FinanceWorkspaceEntry[] }> {
    return { items: await this.workspaces.workspacesFor(user.userId) };
  }

  @Get(':workspaceRef/summary')
  async workspaceSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyFinanceQueryDto,
  ) {
    const summary = await this.workspaces.summaryFor(user.userId, workspaceRef);
    return {
      partyType: summary.partyType,
      receivableNetToman: summary.receivableNetToman,
      settledToman: summary.settledToman,
      outstandingToman: summary.outstandingToman,
      currency: 'IRT',
    };
  }

  @Get(':workspaceRef/outstanding-orders')
  async workspaceOutstanding(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyFinanceQueryDto,
  ) {
    return this.workspaces.outstandingOrdersFor(user.userId, workspaceRef);
  }

  /**
   * One keyset page of settlements, newest first.
   *
   * `nextCursor` is `null` on the last page. The cursor is bound to this
   * workspace: one issued by another workspace is refused with the same body a
   * foreign reference produces, and the check runs before any row is read.
   */
  @Get(':workspaceRef/settlements')
  async workspaceSettlements(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() query: SettlementPageQueryDto,
  ) {
    const page = await this.workspaces.settlementsFor(user.userId, workspaceRef, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toSettlement), nextCursor: page.nextCursor };
  }

  /**
   * One order's ledger, within one owned workspace.
   *
   * Two facts are checked and both are required: the workspace is owned, and the
   * rows belong to it. An order id from another workspace returns an empty list
   * -- indistinguishable from an order that does not exist.
   */
  @Get(':workspaceRef/orders/:orderId/ledger')
  async workspaceOrderLedger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Param('orderId') orderId: string,
    @Query() _query: EmptyFinanceQueryDto,
  ) {
    const entries = await this.workspaces.ledgerFor(user.userId, workspaceRef, orderId);
    return entries.map(toLedgerEntry);
  }

  // =========================================================================
  // Singular routes, kept for compatibility and corrected
  // =========================================================================

  @Get('summary')
  async summary(@CurrentUser() user: AuthenticatedUser) {
    const summary = await this.finance.mySummary(user.userId);
    // A caller with no seller profile gets the same generic response as any
    // other "nothing here for you" -- never a distinct shape that would
    // confirm whether a profile exists.
    if (!summary) throw new NotFoundOrNotYoursException();
    return {
      partyType: summary.partyType,
      receivableNetToman: summary.receivableNetToman,
      settledToman: summary.settledToman,
      outstandingToman: summary.outstandingToman,
      currency: 'IRT',
    };
  }

  @Get('outstanding-orders')
  async outstanding(@CurrentUser() user: AuthenticatedUser) {
    const orders = await this.finance.myOutstandingOrders(user.userId);
    if (!orders) throw new NotFoundOrNotYoursException();
    return orders;
  }

  @Get('settlements')
  async settlements(@CurrentUser() user: AuthenticatedUser) {
    const batches = await this.finance.mySettlements(user.userId);
    if (!batches) throw new NotFoundOrNotYoursException();
    return batches.map(toSettlement);
  }

  @Get('orders/:orderId/ledger')
  async orderLedger(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    const entries = await this.finance.myLedgerForOrder(user.userId, orderId);
    if (!entries) throw new NotFoundOrNotYoursException();
    return entries.map(toLedgerEntry);
  }
}

/**
 * Cross-party financial operations, for platform operators only.
 *
 * Deliberately a SEPARATE controller and a separate service from the
 * self-service surface, both gated on `bc_manage_platform`. Keeping the
 * party-argument-taking methods off the class a normal session can reach is
 * the structural half of the GAP-05 fix -- the capability check is the
 * other half, and neither is relied on alone.
 */
@Controller('v1/admin/finance')
export class FinancialAdminController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly settlements: SettlementService,
    private readonly audit: AdminAuditService,
  ) {}

  @RequireCapability('bc_manage_platform')
  @Get('totals')
  async totals() {
    return this.ledger.platformTotals();
  }

  @RequireCapability('bc_manage_platform')
  @Get('parties/summary')
  async partySummary(@Query() query: PartyQueryDto) {
    return this.settlements.partySummary(query.partyType as LedgerPartyType, query.partyId);
  }

  @RequireCapability('bc_manage_platform')
  @Get('parties/outstanding-orders')
  async partyOutstanding(@Query() query: PartyQueryDto) {
    return this.settlements.outstandingOrdersForParty(query.partyType as LedgerPartyType, query.partyId);
  }

  @RequireCapability('bc_manage_platform')
  @AuditAction('financial.settlement_created', {
    transactional: false,
    because:
      'financial is a physically separate DataSource connected as the append-only writer role (ADR-017), so a settlement and an admin.admin_audit_log row have no shared transaction to commit in. The AUTHORITATIVE record of this action is financial.settlement_batches itself, which is append-only at the database-role level and already carries the actor; the admin row is written afterwards so an operator has one place to look.',
  })
  @Post('settlements')
  async createSettlement(@Body() dto: CreateSettlementDto, @CurrentUser() user: AuthenticatedUser) {
    const batch = await this.settlements.createSettlement({
      partyType: dto.partyType,
      partyId: dto.partyId,
      orderIds: dto.orderIds,
      method: dto.method ?? null,
      reference: dto.reference ?? null,
      note: dto.note ?? null,
      actorId: user.userId,
    });
    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'financial.settlement_created',
      targetType: 'settlement_batch',
      targetId: batch.id,
      after: {
        partyType: dto.partyType,
        partyId: dto.partyId,
        amountToman: batch.amountToman,
        orderCount: dto.orderIds.length,
        method: dto.method ?? null,
      },
      reason: dto.note ?? null,
    });
    return { id: batch.id, amountToman: batch.amountToman, createdAt: batch.createdAt.toISOString() };
  }

  @RequireCapability('bc_manage_platform')
  @AuditAction('financial.settlement_reversed', {
    transactional: false,
    because:
      'Same separate-DataSource boundary as settlement creation (ADR-017). financial.settlement_items records the reversal append-only with its actor and reason; the admin row follows.',
  })
  @Post('settlements/:id/reverse')
  async reverseSettlement(
    @Param('id') id: string,
    @Body() dto: ReverseSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const reversal = await this.settlements.reverseSettlement(id, user.userId, dto.reason);
    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'financial.settlement_reversed',
      targetType: 'settlement_batch',
      targetId: id,
      after: { reversalId: reversal.id, amountToman: reversal.amountToman },
      reason: dto.reason,
    });
    return { id: reversal.id, reversesSettlementId: reversal.reversesSettlementId, amountToman: reversal.amountToman };
  }
}
