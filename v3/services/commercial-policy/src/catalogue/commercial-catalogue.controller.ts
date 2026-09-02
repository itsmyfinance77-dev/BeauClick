import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';

import { AuditAction } from '@beauclick/audit';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import {
  CommercialPlanVersionEntity,
  CommercialPriceScheduleVersionEntity,
} from './commercial-catalogue.entities';
import {
  CreatePlanDto,
  CreatePriceScheduleDto,
  ReasonDto,
  WritePlanVersionDto,
  WriteScheduleVersionDto,
} from './commercial-catalogue.dto';
import { CommercialCatalogueService } from './commercial-catalogue.service';

/**
 * The administrator surface for the plan and price catalogue — Issue #40
 * (`#40a`), ADR-041 §14.
 *
 * ## Everything here is gated on one privileged capability
 *
 * `@RequireCapability('bc_manage_commercial_plans')` is declared on the CLASS
 * and `CapabilityGuard` reads it with `getAllAndOverride`, so it applies to
 * every handler — the exact arrangement that used to be a silent no-op, and the
 * reason that guard's docblock exists. The suite asserts it over the real route
 * table rather than trusting the decorator's placement.
 *
 * Because the capability is in `PRIVILEGED_CAPABILITIES`, two further things
 * hold automatically: a live revocation re-check on every request, and
 * `libs/audit`'s refusal to BOOT if any mutation here declares no audit action.
 *
 * ## Every mutation is audited IN ITS OWN TRANSACTION
 *
 * `@AuditAction(...)` carries no `transactional: false` anywhere on this
 * controller, and that is a substantive claim rather than an omission: the
 * audit row is written by `CommercialCatalogueService` inside the same
 * transaction as the domain change, so the two commit together or not at all.
 * There is no physically separate DataSource and no external system here to
 * justify the detached form.
 *
 * ## What the reads do NOT return
 *
 * No response body below contains `createdByUserId`, `publishedByUserId` or
 * `retiredByUserId`. Who published a plan is an administrative fact for the
 * audit log; putting it in a catalogue listing would push administrator
 * identity into every client that renders one, and no approved contract asks
 * for it.
 *
 * ## What is deliberately absent
 *
 * No seller-facing route of any kind: no subscription, no selection, no
 * purchase, no top-up, no grant, no balance, no consumption and no return.
 * Those are #56, #57 and #58. There is also no quote or preview route — the
 * pricing engine is a domain service proved by test, and a public price
 * endpoint is #57's to design.
 */
@Controller('v1/admin/commercial')
@RequireCapability('bc_manage_commercial_plans')
export class CommercialCatalogueController {
  constructor(private readonly catalogue: CommercialCatalogueService) {}

  // =========================================================================
  // Catalogue keys
  // =========================================================================

  @Get('plans')
  async listPlans() {
    const plans = await this.catalogue.listPlans();
    return { items: plans.map((plan) => ({ planKey: plan.planKey, createdAt: plan.createdAt.toISOString() })) };
  }

  @Post('plans')
  @AuditAction('commercial.plan_created')
  async createPlan(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePlanDto) {
    // `user.userId` is the verified session. `CreatePlanDto` declares no actor
    // field, so there is nothing for a caller to supply and nothing to ignore.
    const plan = await this.catalogue.createPlan(user.userId, dto.planKey, dto.reason);
    return { planKey: plan.planKey, createdAt: plan.createdAt.toISOString() };
  }

  @Get('price-schedules')
  async listPriceSchedules() {
    const schedules = await this.catalogue.listPriceSchedules();
    return {
      items: schedules.map((schedule) => ({
        scheduleKey: schedule.scheduleKey,
        purpose: schedule.purpose,
        createdAt: schedule.createdAt.toISOString(),
      })),
    };
  }

  @Post('price-schedules')
  @AuditAction('commercial.price_schedule_created')
  async createPriceSchedule(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePriceScheduleDto) {
    const schedule = await this.catalogue.createPriceSchedule(user.userId, dto.scheduleKey, dto.purpose, dto.reason);
    return {
      scheduleKey: schedule.scheduleKey,
      purpose: schedule.purpose,
      createdAt: schedule.createdAt.toISOString(),
    };
  }

  // =========================================================================
  // Price schedule versions
  // =========================================================================

  @Get('price-schedules/:scheduleKey/versions')
  async listScheduleVersions(@Param('scheduleKey') scheduleKey: string) {
    const versions = await this.catalogue.listScheduleVersions(scheduleKey);
    return { items: versions.map((version) => this.scheduleVersionView(version)) };
  }

  @Get('price-schedules/:scheduleKey/versions/:version')
  async getScheduleVersion(
    @Param('scheduleKey') scheduleKey: string,
    @Param('version', new ParseIntPipe()) version: number,
  ) {
    const resolved = await this.catalogue.getScheduleVersionWithTerms(scheduleKey, version);
    return {
      ...this.scheduleVersionView(resolved.version),
      uiPresetQuantities: resolved.terms.uiPresetQuantities,
      tiers: resolved.terms.tiers,
    };
  }

  @Post('price-schedules/:scheduleKey/versions')
  @AuditAction('commercial.price_schedule_version_drafted')
  async draftScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('scheduleKey') scheduleKey: string,
    @Body() dto: WriteScheduleVersionDto,
  ) {
    const created = await this.catalogue.createScheduleVersionDraft(
      user.userId,
      { scheduleKey, ...this.scheduleInput(dto) },
      dto.reason,
    );
    return this.scheduleVersionView(created);
  }

  /**
   * Edits a DRAFT.
   *
   * `PUT` rather than `PATCH`, because a tier set has no identity a caller
   * supplies: the set IS the value, and a partial update of it would have no
   * defined meaning. The service replaces it wholesale, and the database
   * refuses either half of that if the version has left draft.
   */
  @Put('price-schedules/:scheduleKey/versions/:version')
  @AuditAction('commercial.price_schedule_version_edited')
  async editScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('scheduleKey') scheduleKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: WriteScheduleVersionDto,
  ) {
    const updated = await this.catalogue.updateScheduleVersionDraft(
      user.userId,
      scheduleKey,
      version,
      this.scheduleInput(dto),
      dto.reason,
    );
    return this.scheduleVersionView(updated);
  }

  @Post('price-schedules/:scheduleKey/versions/:version/publish')
  @AuditAction('commercial.price_schedule_version_published')
  async publishScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('scheduleKey') scheduleKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    const published = await this.catalogue.publishScheduleVersion(user.userId, scheduleKey, version, dto.reason);
    return this.scheduleVersionView(published);
  }

  @Post('price-schedules/:scheduleKey/versions/:version/retire')
  @AuditAction('commercial.price_schedule_version_retired')
  async retireScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('scheduleKey') scheduleKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    const retired = await this.catalogue.retireScheduleVersion(user.userId, scheduleKey, version, dto.reason);
    return this.scheduleVersionView(retired);
  }

  /**
   * Discards a draft.
   *
   * Necessary rather than convenient: publishing is permanent, so an
   * administrator who has drafted the wrong terms needs a way out that is not
   * "publish it and retire it", which would leave a wrong version in the
   * catalogue's history forever. The database permits deleting a draft and
   * nothing else.
   */
  @Delete('price-schedules/:scheduleKey/versions/:version')
  @AuditAction('commercial.price_schedule_version_discarded')
  async discardScheduleVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('scheduleKey') scheduleKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    await this.catalogue.discardScheduleVersionDraft(user.userId, scheduleKey, version, dto.reason);
    return { scheduleKey, version, discarded: true };
  }

  // =========================================================================
  // Plan versions
  // =========================================================================

  @Get('plans/:planKey/versions')
  async listPlanVersions(@Param('planKey') planKey: string) {
    const versions = await this.catalogue.listPlanVersions(planKey);
    return { items: versions.map((version) => this.planVersionView(version)) };
  }

  @Get('plans/:planKey/versions/:version')
  async getPlanVersion(@Param('planKey') planKey: string, @Param('version', new ParseIntPipe()) version: number) {
    return this.planVersionView(await this.catalogue.getPlanVersion(planKey, version));
  }

  @Post('plans/:planKey/versions')
  @AuditAction('commercial.plan_version_drafted')
  async draftPlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planKey') planKey: string,
    @Body() dto: WritePlanVersionDto,
  ) {
    const created = await this.catalogue.createPlanVersionDraft(
      user.userId,
      { planKey, ...this.planInput(dto) },
      dto.reason,
    );
    return this.planVersionView(created);
  }

  @Put('plans/:planKey/versions/:version')
  @AuditAction('commercial.plan_version_edited')
  async editPlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planKey') planKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: WritePlanVersionDto,
  ) {
    const updated = await this.catalogue.updatePlanVersionDraft(
      user.userId,
      planKey,
      version,
      this.planInput(dto),
      dto.reason,
    );
    return this.planVersionView(updated);
  }

  @Post('plans/:planKey/versions/:version/publish')
  @AuditAction('commercial.plan_version_published')
  async publishPlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planKey') planKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.planVersionView(await this.catalogue.publishPlanVersion(user.userId, planKey, version, dto.reason));
  }

  @Post('plans/:planKey/versions/:version/retire')
  @AuditAction('commercial.plan_version_retired')
  async retirePlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planKey') planKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    return this.planVersionView(await this.catalogue.retirePlanVersion(user.userId, planKey, version, dto.reason));
  }

  @Delete('plans/:planKey/versions/:version')
  @AuditAction('commercial.plan_version_discarded')
  async discardPlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planKey') planKey: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body() dto: ReasonDto,
  ) {
    await this.catalogue.discardPlanVersionDraft(user.userId, planKey, version, dto.reason);
    return { planKey, version, discarded: true };
  }

  // =========================================================================
  // Views. Explicit field lists, never a spread entity.
  // =========================================================================

  private planVersionView(row: CommercialPlanVersionEntity) {
    return {
      planKey: row.planKey,
      version: row.version,
      lifecycleState: row.lifecycleState,
      displayName: row.displayName,
      billingTermDays: row.billingTermDays,
      includedBookingCredits: row.includedBookingCredits,
      staffSeats: row.staffSeats,
      includedLocations: row.includedLocations,
      capabilityKeys: row.capabilityKeys,
      priceScheduleVersionId: row.priceScheduleVersionId,
      autoAssignable: row.autoAssignable,
      activationStartsAt: row.activationStartsAt.toISOString(),
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
      // `createdByUserId`, `publishedByUserId` and `retiredByUserId` are
      // deliberately absent. See the class docblock.
    };
  }

  private scheduleVersionView(row: CommercialPriceScheduleVersionEntity) {
    return {
      scheduleKey: row.scheduleKey,
      version: row.version,
      lifecycleState: row.lifecycleState,
      displayName: row.displayName,
      currency: row.currencyCode,
      minPurchaseQuantity: row.minPurchaseQuantity,
      maxPurchaseQuantity: row.maxPurchaseQuantity,
      activationStartsAt: row.activationStartsAt.toISOString(),
      activationEndsAt: row.activationEndsAt ? row.activationEndsAt.toISOString() : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    };
  }

  private scheduleInput(dto: WriteScheduleVersionDto) {
    return {
      displayName: dto.displayName,
      activationStartsAt: new Date(dto.activationStartsAt),
      activationEndsAt: dto.activationEndsAt ? new Date(dto.activationEndsAt) : null,
      terms: {
        currency: 'IRT' as const,
        minPurchaseQuantity: dto.minPurchaseQuantity,
        maxPurchaseQuantity: dto.maxPurchaseQuantity,
        uiPresetQuantities: dto.uiPresetQuantities,
        tiers: dto.tiers.map((tier) => ({
          minQuantity: tier.minQuantity,
          // `undefined` reaches here when a caller sends no value at all, and
          // the contract's shape is `number | null`. Normalising rather than
          // widening the type keeps "unbounded" one representation.
          maxQuantity: tier.maxQuantity ?? null,
          unitPriceToman: tier.unitPriceToman,
        })),
      },
    };
  }

  private planInput(dto: WritePlanVersionDto) {
    return {
      priceScheduleVersionId: dto.priceScheduleVersionId,
      autoAssignable: dto.autoAssignable,
      activationStartsAt: new Date(dto.activationStartsAt),
      activationEndsAt: dto.activationEndsAt ? new Date(dto.activationEndsAt) : null,
      terms: {
        displayName: dto.displayName,
        billingTermDays: dto.billingTermDays ?? null,
        includedBookingCredits: dto.includedBookingCredits,
        staffSeats: dto.staffSeats,
        includedLocations: dto.includedLocations,
        capabilityKeys: dto.capabilityKeys,
      },
    };
  }
}
