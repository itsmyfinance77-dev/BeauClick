import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';

import { AuditAction } from '@beauclick/audit';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import { ReasonDto } from '../catalogue/commercial-catalogue.dto';
import { COMMISSION_AUDIT_ACTIONS } from './commission-policy.constants';
import { CreateCommissionPolicyDto, WriteCommissionVersionDto } from './commission-policy.dto';
import { CommissionPolicyVersionEntity } from './commission-policy.entities';
import { CommissionPolicyService, CommissionRuleInput } from './commission-policy.service';

/**
 * The administrator surface of `#43b-1` — V3.3 Story #173, ADR-052 §1.
 *
 * Mounted under the existing commercial administrator namespace and
 * class-gated on the privileged `bc_manage_commercial_plans`, exactly as the
 * catalogue, enforcement and outcome-policy controllers are: live revocation
 * on every request, and `libs/audit`'s refusal to boot if any mutation here
 * declares no audit action. Every `@AuditAction` names a member of the closed
 * vocabulary in `commission-policy.constants.ts`, and the service writes that
 * same member in the mutation's own transaction.
 *
 * ## What the reads do NOT return
 *
 * No `createdByUserId`, `publishedByUserId`, `retiredByUserId`, audit id or
 * row id. No response reaches a seller or a customer: there is no
 * non-privileged route on this controller, and what a seller is eventually
 * told about commission is a separate, unratified surface.
 *
 * ## What is deliberately absent
 *
 * No order snapshot (`#43b-2`, #192), no recognition, release or receivable
 * (`#43c`), no fee allocation (`#43g`), no settlement schedule (`#43d`); no
 * `workspaceRef`, party, seller, order or booking selector of any kind.
 */
@Controller('v1/admin/commercial')
@RequireCapability('bc_manage_commercial_plans')
export class CommissionPolicyController {
  constructor(private readonly policies: CommissionPolicyService) {}

  @Get('commission-policies')
  async listCommissionPolicies() {
    const items = await this.policies.listPolicies();
    return {
      items: items.map((policy) => ({
        policyKey: policy.policyKey,
        component: policy.component,
        displayName: policy.displayName,
        createdAt: policy.createdAt.toISOString(),
      })),
    };
  }

  @Post('commission-policies')
  @AuditAction(COMMISSION_AUDIT_ACTIONS.policyCreated)
  async createCommissionPolicy(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCommissionPolicyDto) {
    const policy = await this.policies.createPolicy(user.userId, dto.policyKey, dto.component, dto.displayName, dto.reason);
    return {
      policyKey: policy.policyKey,
      component: policy.component,
      displayName: policy.displayName,
      createdAt: policy.createdAt.toISOString(),
    };
  }

  @Get('commission-policies/:policyKey/versions')
  async listCommissionVersions(@Param('policyKey') policyKey: string) {
    const versions = await this.policies.listVersions(policyKey);
    return { items: versions.map((version) => this.versionView(version)) };
  }

  @Get('commission-policies/:policyKey/versions/:version')
  async getCommissionVersion(@Param('policyKey') policyKey: string, @Param('version', new ParseIntPipe()) version: number) {
    return this.versionView(await this.policies.getVersion(policyKey, version));
  }

  @Post('commission-policies/:policyKey/versions')
  @AuditAction(COMMISSION_AUDIT_ACTIONS.versionDrafted)
  async draftCommissionVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Body() dto: WriteCommissionVersionDto,
  ) {
    return this.versionView(await this.policies.createVersionDraft(user.userId, policyKey, this.ruleInput(dto), dto.reason));
  }

  @Put('commission-policies/:policyKey/versions/:version')
  @AuditAction(COMMISSION_AUDIT_ACTIONS.versionUpdated)
  async replaceCommissionVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: WriteCommissionVersionDto,
  ) {
    return this.versionView(
      await this.policies.replaceVersionDraft(user.userId, policyKey, version, this.ruleInput(dto), dto.reason),
    );
  }

  @Delete('commission-policies/:policyKey/versions/:version')
  @AuditAction(COMMISSION_AUDIT_ACTIONS.versionDiscarded)
  async discardCommissionVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    await this.policies.discardVersionDraft(user.userId, policyKey, version, dto.reason);
    return { discarded: true };
  }

  @Post('commission-policies/:policyKey/versions/:version/publish')
  @AuditAction(COMMISSION_AUDIT_ACTIONS.versionPublished)
  async publishCommissionVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.versionView(await this.policies.publishVersion(user.userId, policyKey, version, dto.reason));
  }

  @Post('commission-policies/:policyKey/versions/:version/retire')
  @AuditAction(COMMISSION_AUDIT_ACTIONS.versionRetired)
  async retireCommissionVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.versionView(await this.policies.retireVersion(user.userId, policyKey, version, dto.reason));
  }

  /** `undefined` (the field was omitted) and `null` (absent) are one thing to the service. */
  private ruleInput(dto: WriteCommissionVersionDto): CommissionRuleInput {
    return {
      ruleKind: dto.ruleKind,
      basisPoints: dto.basisPoints ?? null,
      fixedToman: dto.fixedToman ?? null,
      base: dto.base ?? null,
      activationEndsAt: dto.activationEndsAt ? new Date(dto.activationEndsAt) : null,
    };
  }

  private versionView(version: CommissionPolicyVersionEntity) {
    return {
      policyKey: version.policyKey,
      version: version.version,
      lifecycleState: version.lifecycleState,
      ruleKind: version.ruleKind,
      basisPoints: version.basisPoints,
      fixedToman: version.fixedToman,
      base: version.base,
      arithmeticVersion: version.arithmeticVersion,
      activationStartsAt: version.activationStartsAt?.toISOString() ?? null,
      activationEndsAt: version.activationEndsAt?.toISOString() ?? null,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      retiredAt: version.retiredAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
    };
  }
}
