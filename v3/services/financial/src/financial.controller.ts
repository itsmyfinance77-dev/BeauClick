import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { RequireCapability } from '@beauclick/auth';

import { MyFinanceService } from './my-finance.service';
import { LedgerService } from './ledger.service';
import { SettlementService } from './settlement.service';
import { LedgerPartyType } from './entities/ledger-entry.entity';
import { CreateSettlementDto, PartyQueryDto, ReverseSettlementDto } from './dto/settlement.dto';

/**
 * A seller's own finances. Every route is `/v1/me/finance/...` and every
 * handler passes ONLY the session user id downstream -- there is no party
 * path parameter, query parameter, or body field anywhere on this
 * controller, so cross-party access is not something a check could fail to
 * catch; it is unrepresentable.
 */
@Controller('v1/me/finance')
export class MyFinanceController {
  constructor(private readonly finance: MyFinanceService) {}

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
    return batches.map((b) => ({
      id: b.id,
      kind: b.kind,
      amountToman: b.amountToman,
      currency: b.currency,
      method: b.method,
      reference: b.reference,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  @Get('orders/:orderId/ledger')
  async orderLedger(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    const entries = await this.finance.myLedgerForOrder(user.userId, orderId);
    if (!entries) throw new NotFoundOrNotYoursException();
    return entries.map((e) => ({
      id: e.id,
      entryType: e.entryType,
      amountToman: e.amountToman,
      currency: e.currency,
      commissionRateBp: e.commissionRateBp,
      referenceType: e.referenceType,
      createdAt: e.createdAt.toISOString(),
    }));
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
    return { id: batch.id, amountToman: batch.amountToman, createdAt: batch.createdAt.toISOString() };
  }

  @RequireCapability('bc_manage_platform')
  @Post('settlements/:id/reverse')
  async reverseSettlement(
    @Param('id') id: string,
    @Body() dto: ReverseSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const reversal = await this.settlements.reverseSettlement(id, user.userId, dto.reason);
    return { id: reversal.id, reversesSettlementId: reversal.reversesSettlementId, amountToman: reversal.amountToman };
  }
}
