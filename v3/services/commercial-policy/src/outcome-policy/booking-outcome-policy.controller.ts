import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';

import { AuditAction } from '@beauclick/audit';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import type { BookingOutcomeRetentionRule } from '@beauclick/commercial-policy-contract';

import { OUTCOME_POLICY_AUDIT_ACTIONS } from './booking-outcome-policy.constants';
import {
  CreateBookingOutcomePolicyDto,
  CreateCustomerPolicyCopyDto,
  OutcomeRetentionRuleDto,
  RecordLegalEvidenceDto,
  WriteBookingOutcomePolicyVersionDto,
  WriteCustomerPolicyCopyVersionDto,
} from './booking-outcome-policy.dto';
import {
  BookingOutcomePolicyRetentionOptionEntity,
  CustomerPolicyCopyVersionEntity,
  LegalEvidenceRecordEntity,
} from './booking-outcome-policy.entities';
import {
  BookingOutcomePolicyService,
  BookingOutcomePolicyVersionRecord,
  WriteBookingOutcomePolicyVersionInput,
} from './booking-outcome-policy.service';
import { CustomerPolicyCopyService, WriteCustomerPolicyCopyVersionInput } from './customer-policy-copy.service';
import { LegalEvidenceService } from './legal-evidence.service';
import { ReasonDto } from '../catalogue/commercial-catalogue.dto';

/**
 * The administrator surface of `#42a` — V3.3 Story #42, ADR-051 §1 and §5.
 *
 * Mounted under the existing commercial administrator namespace and
 * class-gated on the privileged `bc_manage_commercial_plans`, exactly as the
 * catalogue and enforcement controllers are: live revocation on every request
 * and `libs/audit`'s refusal to boot if any mutation here declares no audit
 * action. Every `@AuditAction` names a member of the closed vocabulary in
 * `booking-outcome-policy.constants.ts`, and the service writes that same
 * member in the mutation's own transaction.
 *
 * ## What the reads do NOT return
 *
 * No `createdByUserId`, `publishedByUserId`, `retiredByUserId`,
 * `recordedByUserId`, audit id or row id of another table. Legal evidence is
 * addressed by its administrator-facing KEY; the FK id never leaves the
 * service. No response reaches a customer or a seller: there is no
 * non-privileged route on this controller.
 *
 * ## What is deliberately absent
 *
 * No seller selection or catalogue read (`#42b`), no evaluator or decision
 * (`#42c`), no declaration or remedy (`#42d`), no dispute (`#42e`); no
 * `workspaceRef`, party, owner, customer or booking selector of any kind.
 */
@Controller('v1/admin/commercial')
@RequireCapability('bc_manage_commercial_plans')
export class BookingOutcomePolicyController {
  constructor(
    private readonly policies: BookingOutcomePolicyService,
    private readonly copies: CustomerPolicyCopyService,
    private readonly evidence: LegalEvidenceService,
  ) {}

  // =========================================================================
  // Booking-outcome policy family
  // =========================================================================

  @Get('outcome-policies')
  async listOutcomePolicies() {
    const items = await this.policies.listPolicies();
    return { items: items.map((p) => ({ policyKey: p.policyKey, displayName: p.displayName, createdAt: p.createdAt.toISOString() })) };
  }

  @Post('outcome-policies')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.policyCreated)
  async createOutcomePolicy(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBookingOutcomePolicyDto) {
    const policy = await this.policies.createPolicy(user.userId, dto.policyKey, dto.displayName, dto.reason);
    return { policyKey: policy.policyKey, displayName: policy.displayName, createdAt: policy.createdAt.toISOString() };
  }

  @Get('outcome-policies/:policyKey/versions')
  async listOutcomePolicyVersions(@Param('policyKey') policyKey: string) {
    const versions = await this.policies.listVersions(policyKey);
    return { items: versions.map((v) => this.versionView(v)) };
  }

  @Get('outcome-policies/:policyKey/versions/:version')
  async getOutcomePolicyVersion(@Param('policyKey') policyKey: string, @Param('version', new ParseIntPipe()) version: number) {
    return this.versionView(await this.policies.getVersion(policyKey, version));
  }

  @Post('outcome-policies/:policyKey/versions')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.versionDrafted)
  async draftOutcomePolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Body() dto: WriteBookingOutcomePolicyVersionDto,
  ) {
    const draft = await this.policies.createVersionDraft(user.userId, { policyKey, ...this.versionInput(dto) }, dto.reason);
    return this.versionView(draft);
  }

  @Put('outcome-policies/:policyKey/versions/:version')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.versionUpdated)
  async replaceOutcomePolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: WriteBookingOutcomePolicyVersionDto,
  ) {
    return this.versionView(await this.policies.replaceVersionDraft(user.userId, policyKey, version, this.versionInput(dto), dto.reason));
  }

  @Post('outcome-policies/:policyKey/versions/:version/publish')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.versionPublished)
  async publishOutcomePolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.versionView(await this.policies.publishVersion(user.userId, policyKey, version, dto.reason));
  }

  @Post('outcome-policies/:policyKey/versions/:version/retire')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.versionRetired)
  async retireOutcomePolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.versionView(await this.policies.retireVersion(user.userId, policyKey, version, dto.reason));
  }

  @Delete('outcome-policies/:policyKey/versions/:version')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.versionDiscarded)
  async discardOutcomePolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('policyKey') policyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    await this.policies.discardVersionDraft(user.userId, policyKey, version, dto.reason);
    return { policyKey, version, discarded: true };
  }

  // =========================================================================
  // Customer policy copy family (Persian text as data)
  // =========================================================================

  @Get('customer-policy-copies')
  async listCustomerPolicyCopies() {
    const items = await this.copies.listCopies();
    return { items: items.map((c) => ({ copyKey: c.copyKey, displayName: c.displayName, createdAt: c.createdAt.toISOString() })) };
  }

  @Post('customer-policy-copies')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.copyCreated)
  async createCustomerPolicyCopy(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCustomerPolicyCopyDto) {
    const copy = await this.copies.createCopy(user.userId, dto.copyKey, dto.displayName, dto.reason);
    return { copyKey: copy.copyKey, displayName: copy.displayName, createdAt: copy.createdAt.toISOString() };
  }

  @Get('customer-policy-copies/:copyKey/versions')
  async listCustomerPolicyCopyVersions(@Param('copyKey') copyKey: string) {
    const versions = await this.copies.listVersions(copyKey);
    return { items: versions.map((v) => this.copyVersionView(v, false)) };
  }

  @Get('customer-policy-copies/:copyKey/versions/:version')
  async getCustomerPolicyCopyVersion(@Param('copyKey') copyKey: string, @Param('version', new ParseIntPipe()) version: number) {
    return this.copyVersionView(await this.copies.getVersion(copyKey, version), true);
  }

  @Post('customer-policy-copies/:copyKey/versions')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionDrafted)
  async draftCustomerPolicyCopyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('copyKey') copyKey: string,
    @Body() dto: WriteCustomerPolicyCopyVersionDto,
  ) {
    return this.copyVersionView(await this.copies.createVersionDraft(user.userId, { copyKey, ...this.copyInput(dto) }, dto.reason), true);
  }

  @Put('customer-policy-copies/:copyKey/versions/:version')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionUpdated)
  async replaceCustomerPolicyCopyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('copyKey') copyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: WriteCustomerPolicyCopyVersionDto,
  ) {
    return this.copyVersionView(await this.copies.replaceVersionDraft(user.userId, copyKey, version, this.copyInput(dto), dto.reason), true);
  }

  @Post('customer-policy-copies/:copyKey/versions/:version/publish')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionPublished)
  async publishCustomerPolicyCopyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('copyKey') copyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.copyVersionView(await this.copies.publishVersion(user.userId, copyKey, version, dto.reason), false);
  }

  @Post('customer-policy-copies/:copyKey/versions/:version/retire')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionRetired)
  async retireCustomerPolicyCopyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('copyKey') copyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.copyVersionView(await this.copies.retireVersion(user.userId, copyKey, version, dto.reason), false);
  }

  @Delete('customer-policy-copies/:copyKey/versions/:version')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionDiscarded)
  async discardCustomerPolicyCopyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('copyKey') copyKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    await this.copies.discardVersionDraft(user.userId, copyKey, version, dto.reason);
    return { copyKey, version, discarded: true };
  }

  // =========================================================================
  // Legal evidence records
  // =========================================================================

  @Get('legal-evidence')
  async listLegalEvidence() {
    const items = await this.evidence.list();
    return { items: items.map((e) => this.evidenceView(e, false)) };
  }

  @Get('legal-evidence/:evidenceKey')
  async getLegalEvidence(@Param('evidenceKey') evidenceKey: string) {
    return this.evidenceView(await this.evidence.get(evidenceKey), true);
  }

  @Post('legal-evidence')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRecorded)
  async recordLegalEvidence(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordLegalEvidenceDto) {
    const record = await this.evidence.record(
      user.userId,
      dto.evidenceKey,
      { subject: dto.subject, referenceKind: dto.referenceKind, reference: dto.reference, summary: dto.summary },
      dto.reason,
    );
    return this.evidenceView(record, true);
  }

  @Post('legal-evidence/:evidenceKey/retire')
  @AuditAction(OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRetired)
  async retireLegalEvidence(@CurrentUser() user: AuthenticatedUser, @Param('evidenceKey') evidenceKey: string, @Body() dto: ReasonDto) {
    return this.evidenceView(await this.evidence.retire(user.userId, evidenceKey, dto.reason), false);
  }

  // =========================================================================
  // Views. Explicit field lists, never a spread entity, never an actor.
  // =========================================================================

  private versionInput(dto: WriteBookingOutcomePolicyVersionDto): WriteBookingOutcomePolicyVersionInput {
    return {
      terms: {
        contractVersion: 1,
        cutoffHoursAllowed: dto.cutoffHoursAllowed,
        lateRetentionOptions: dto.lateRetentionOptions.map((o) => this.rule(o)),
        noShowGraceMinutesAllowed: dto.noShowGraceMinutesAllowed,
        noShowRetentionOptions: dto.noShowRetentionOptions.map((o) => this.rule(o)),
        rescheduleFreeCountBeforeCutoff: dto.rescheduleFreeCountBeforeCutoff,
        disputeWindowHours: dto.disputeWindowHours,
        bodilyHarmWindowHours: dto.bodilyHarmWindowHours ?? null,
        appealWindowHours: dto.appealWindowHours,
        caseFileRetentionDays: dto.caseFileRetentionDays ?? null,
        legalCap: dto.legalCap ? this.rule(dto.legalCap) : null,
      },
      legalEvidenceKey: dto.legalEvidenceKey ?? null,
      activationEndsAt: dto.activationEndsAt ? new Date(dto.activationEndsAt) : null,
    };
  }

  /** Assembles the flat DTO into the discriminated union; every field not belonging to the kind is dropped HERE. */
  private rule(dto: OutcomeRetentionRuleDto): BookingOutcomeRetentionRule {
    switch (dto.kind) {
      case 'percentage_of_collected':
        return { kind: 'percentage_of_collected', basisPoints: dto.basisPoints as number };
      case 'fixed_toman':
        return { kind: 'fixed_toman', amountToman: dto.amountToman as number };
      case 'full_collected':
        return { kind: 'full_collected' };
      default:
        return { kind: 'none' };
    }
  }

  private optionView(o: BookingOutcomePolicyRetentionOptionEntity) {
    return o.kind === 'percentage_of_collected'
      ? { kind: o.kind, basisPoints: o.basisPoints }
      : o.kind === 'fixed_toman'
        ? { kind: o.kind, amountToman: o.amountToman }
        : { kind: o.kind };
  }

  private versionView(record: BookingOutcomePolicyVersionRecord) {
    const row = record.version;
    return {
      policyKey: row.policyKey,
      version: row.version,
      lifecycleState: row.lifecycleState,
      cutoffHoursAllowed: row.cutoffHoursAllowed,
      lateRetentionOptions: record.options.filter((o) => o.purpose === 'late_cancellation').map((o) => this.optionView(o)),
      noShowGraceMinutesAllowed: row.noShowGraceMinutesAllowed,
      noShowRetentionOptions: record.options.filter((o) => o.purpose === 'no_show').map((o) => this.optionView(o)),
      rescheduleFreeCountBeforeCutoff: row.rescheduleFreeCountBeforeCutoff,
      disputeWindowHours: row.disputeWindowHours,
      bodilyHarmWindowHours: row.bodilyHarmWindowHours,
      appealWindowHours: row.appealWindowHours,
      caseFileRetentionDays: row.caseFileRetentionDays,
      legalCap:
        row.legalCapKind === null
          ? null
          : row.legalCapKind === 'percentage_of_collected'
            ? { kind: row.legalCapKind, basisPoints: row.legalCapBasisPoints }
            : row.legalCapKind === 'fixed_toman'
              ? { kind: row.legalCapKind, amountToman: row.legalCapAmountToman }
              : { kind: row.legalCapKind },
      legalEvidenceKey: record.legalEvidenceKey,
      contractVersion: row.contractVersion,
      activationStartsAt: row.activationStartsAt ? row.activationStartsAt.toISOString() : null,
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    };
  }

  private copyInput(dto: WriteCustomerPolicyCopyVersionDto): WriteCustomerPolicyCopyVersionInput {
    return {
      terms: { contractVersion: 1, locale: dto.locale, body: dto.body },
      activationEndsAt: dto.activationEndsAt ? new Date(dto.activationEndsAt) : null,
    };
  }

  /** The body travels only on the single-version read and the write echoes; the list carries the hash. */
  private copyVersionView(row: CustomerPolicyCopyVersionEntity, withBody: boolean) {
    return {
      copyKey: row.copyKey,
      version: row.version,
      lifecycleState: row.lifecycleState,
      locale: row.locale,
      bodySha256: row.bodySha256,
      ...(withBody ? { body: row.body } : {}),
      contractVersion: row.contractVersion,
      activationStartsAt: row.activationStartsAt ? row.activationStartsAt.toISOString() : null,
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    };
  }

  /** The reference and summary travel only on the single-record read; the list is vocabulary and instants. */
  private evidenceView(row: LegalEvidenceRecordEntity, withReference: boolean) {
    return {
      evidenceKey: row.evidenceKey,
      subject: row.subject,
      status: row.status,
      referenceKind: row.referenceKind,
      ...(withReference ? { reference: row.reference, summary: row.summary } : {}),
      recordedAt: row.recordedAt.toISOString(),
      retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    };
  }
}
