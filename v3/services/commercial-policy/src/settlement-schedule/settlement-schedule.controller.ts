import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';

import { AuditAction } from '@beauclick/audit';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import { ReasonDto } from '../catalogue/commercial-catalogue.dto';
import { SETTLEMENT_AUDIT_ACTIONS } from './settlement-schedule.constants';
import {
  AssignSellerRiskClassDto,
  CreateSettlementSchedulePolicyDto,
  WriteSettlementScheduleVersionDto,
} from './settlement-schedule.dto';
import {
  SellerRiskClassAssignmentEntity,
  SettlementSchedulePolicyVersionEntity,
} from './settlement-schedule.entities';
import { SellerRiskClassService } from './seller-risk-class.service';
import { SettlementScheduleInput, SettlementScheduleService } from './settlement-schedule.service';

/**
 * The administrator surface of `#43d` — V3.3 Story #175, ADR-052 §1 and §8.
 *
 * Mounted under the existing commercial administrator namespace and
 * class-gated on the privileged `bc_manage_commercial_plans`, exactly as the
 * catalogue, outcome-policy and commission controllers are: live revocation
 * on every request, and `libs/audit`'s refusal to boot if any mutation here
 * declares no audit action.
 *
 * ## What the reads do NOT return
 *
 * No `createdByUserId`, `publishedByUserId`, `assignedByUserId` or audit id.
 * The risk-class history returns the class and its instants; the free-text
 * `reason` is returned HERE, to an administrator holding the privileged
 * capability, and is deliberately never returned on any seller-facing
 * surface (ADR-027, #175's preflight).
 *
 * ## What is deliberately absent
 *
 * No proposal, batch, reserve posting or payout (`#43e`). No scoring: the
 * class is assigned by a person with a stated reason, never computed.
 */
@Controller('v1/admin/commercial')
@RequireCapability('bc_manage_commercial_plans')
export class SettlementScheduleController {
  constructor(
    private readonly schedules: SettlementScheduleService,
    private readonly riskClasses: SellerRiskClassService,
  ) {}

  // =========================================================================
  // Settlement schedules
  // =========================================================================

  @Get('settlement-schedules')
  async listSchedules() {
    const items = await this.schedules.listPolicies();
    return {
      items: items.map((policy) => ({
        policyKey: policy.policyKey,
        planKey: policy.planKey,
        riskClass: policy.riskClass,
        displayName: policy.displayName,
        createdAt: policy.createdAt.toISOString(),
      })),
    };
  }

  @Post('settlement-schedules')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.policyCreated)
  async createSchedule(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSettlementSchedulePolicyDto) {
    const policy = await this.schedules.createPolicy(
      user.userId,
      dto.policyKey,
      dto.planKey,
      dto.riskClass,
      dto.displayName,
      dto.reason,
    );
    return {
      policyKey: policy.policyKey,
      planKey: policy.planKey,
      riskClass: policy.riskClass,
      displayName: policy.displayName,
      createdAt: policy.createdAt.toISOString(),
    };
  }

  @Get('settlement-schedules/:policyKey/versions')
  async listScheduleVersions(@Param('policyKey') policyKey: string) {
    const versions = await this.schedules.listVersions(policyKey);
    return { items: versions.map((version) => this.versionView(version)) };
  }

  @Get('settlement-schedules/:policyKey/versions/:version')
  async getScheduleVersion(@Param('policyKey') policyKey: string, @Param('version', new ParseIntPipe()) version: number) {
    return this.versionView(await this.schedules.getVersion(policyKey, version));
  }

  @Post('settlement-schedules/:policyKey/versions')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.versionDrafted)
  async draftScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Body() dto: WriteSettlementScheduleVersionDto,
  ) {
    return this.versionView(await this.schedules.createVersionDraft(user.userId, policyKey, this.scheduleInput(dto), dto.reason));
  }

  @Put('settlement-schedules/:policyKey/versions/:version')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.versionUpdated)
  async replaceScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: WriteSettlementScheduleVersionDto,
  ) {
    return this.versionView(
      await this.schedules.replaceVersionDraft(user.userId, policyKey, version, this.scheduleInput(dto), dto.reason),
    );
  }

  @Delete('settlement-schedules/:policyKey/versions/:version')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.versionDiscarded)
  async discardScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    await this.schedules.discardVersionDraft(user.userId, policyKey, version, dto.reason);
    return { discarded: true };
  }

  @Post('settlement-schedules/:policyKey/versions/:version/publish')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.versionPublished)
  async publishScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.versionView(await this.schedules.publishVersion(user.userId, policyKey, version, dto.reason));
  }

  @Post('settlement-schedules/:policyKey/versions/:version/retire')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.versionRetired)
  async retireScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.versionView(await this.schedules.retireVersion(user.userId, policyKey, version, dto.reason));
  }

  // =========================================================================
  // Seller risk class
  // =========================================================================

  @Get('seller-risk-classes')
  async riskClassHistory(
    @Query('partyType') partyType: 'professional' | 'business',
    @Query('partyId') partyId: string,
  ) {
    const rows = await this.riskClasses.historyFor({ partyType, partyId });
    return { items: rows.map((row) => this.riskClassView(row)) };
  }

  @Post('seller-risk-classes')
  @AuditAction(SETTLEMENT_AUDIT_ACTIONS.riskClassAssigned)
  async assignRiskClass(@CurrentUser() user: AuthenticatedUser, @Body() dto: AssignSellerRiskClassDto) {
    const assigned = await this.riskClasses.assign(
      user.userId,
      { partyType: dto.partyType, partyId: dto.partyId },
      dto.riskClass,
      dto.reason,
    );
    return this.riskClassView(assigned);
  }

  private scheduleInput(dto: WriteSettlementScheduleVersionDto): SettlementScheduleInput {
    return {
      settlementIntervalDays: dto.settlementIntervalDays,
      minimumPayoutToman: dto.minimumPayoutToman ?? null,
      reserveBasisPoints: dto.reserveBasisPoints ?? null,
      reserveCapToman: dto.reserveCapToman ?? null,
      activationEndsAt: dto.activationEndsAt ? new Date(dto.activationEndsAt) : null,
    };
  }

  private versionView(version: SettlementSchedulePolicyVersionEntity) {
    return {
      policyKey: version.policyKey,
      version: version.version,
      lifecycleState: version.lifecycleState,
      settlementIntervalDays: version.settlementIntervalDays,
      minimumPayoutToman: version.minimumPayoutToman,
      reserveBasisPoints: version.reserveBasisPoints,
      reserveCapToman: version.reserveCapToman,
      activationStartsAt: version.activationStartsAt?.toISOString() ?? null,
      activationEndsAt: version.activationEndsAt?.toISOString() ?? null,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      retiredAt: version.retiredAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
    };
  }

  /** Administrator projection: the reason IS included here, and nowhere a seller can reach. */
  private riskClassView(row: SellerRiskClassAssignmentEntity) {
    return {
      riskClass: row.riskClass,
      reason: row.reason,
      assignedAt: row.assignedAt.toISOString(),
      supersededAt: row.supersededAt?.toISOString() ?? null,
      current: row.supersededAt === null,
    };
  }
}
