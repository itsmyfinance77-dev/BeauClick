/**
 * DEMO BRANCH ONLY — F-10 (demo/F10-DESIGN.md). Administrator-only
 * (`bc_execute_manual_refunds`) controlled manual-refund execution:
 *
 *   GET  /v1/admin/refunds/manual                                 — manual/superseded refunds + executions
 *   POST /v1/admin/refunds/manual/:refundId/claim                 — { note? }  the exclusive claim, BEFORE any transfer
 *   POST /v1/admin/refunds/manual/executions/:executionId/resolve — { outcome, externalReference?, note? }
 *
 * Synthetic in the demo: no bank, no transfer.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuditAction } from '@beauclick/audit';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import { MANUAL_REFUND_AUDIT_ACTIONS, ManualRefundExecutionService, ManualRefundOutcome } from './manual-refund-execution.service';

export class ClaimManualRefundDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ResolveManualRefundDto {
  @IsIn(['executed', 'uncertain', 'released'])
  outcome!: ManualRefundOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@Controller('v1/admin/refunds/manual')
@RequireCapability('bc_execute_manual_refunds')
export class ManualRefundExecutionController {
  constructor(private readonly executions: ManualRefundExecutionService) {}

  @Get()
  async list() {
    const rows = await this.executions.list();
    return rows.map((r) => ({
      refundId: r.id,
      orderId: r.orderId,
      amountToman: r.amountToman,
      status: r.status,
      manualTracked: r.manualTracked,
      reason: r.reason,
      requestedAt: r.createdAt,
      supersededAt: r.supersededAt,
      executions: r.executions.map((e) => ({
        executionId: e.id,
        state: e.state,
        claimedAt: e.claimedAt,
        resolvedAt: e.resolvedAt,
        externalReference: e.externalReference,
        note: e.note,
      })),
    }));
  }

  @Post(':refundId/claim')
  @AuditAction(MANUAL_REFUND_AUDIT_ACTIONS.claimed)
  async claim(@Param('refundId', new ParseUUIDPipe()) refundId: string, @Body() dto: ClaimManualRefundDto, @CurrentUser() user: AuthenticatedUser) {
    const e = await this.executions.claim(user.userId, refundId, dto.note?.trim() || null);
    return { executionId: e.id, state: e.state, refundId: e.refundId };
  }

  @Post('executions/:executionId/resolve')
  @AuditAction(MANUAL_REFUND_AUDIT_ACTIONS.resolved)
  async resolve(
    @Param('executionId', new ParseUUIDPipe()) executionId: string,
    @Body() dto: ResolveManualRefundDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const r = await this.executions.resolve(user.userId, executionId, dto.outcome, dto.externalReference ?? null, dto.note?.trim() || null);
    return { executionId: r.execution.id, state: r.execution.state, refundId: r.refund.id, refundStatus: r.refund.status };
  }
}
