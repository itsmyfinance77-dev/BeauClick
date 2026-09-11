import { Body, Controller, Get, Post } from '@nestjs/common';

import { AuditAction } from '@beauclick/audit';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import { ReasonDto } from '../catalogue/commercial-catalogue.dto';
import { BookingCreditEnforcementGovernanceService } from './booking-credit-enforcement-governance.service';
import { ENFORCEMENT_AUDIT_ACTIONS } from './booking-credit-enforcement.constants';

/**
 * The privileged administrator sub-resource for the booking-credit
 * enforcement control plane -- V3.3 Story #95 (`#58b-1`), ADR-050 §5,
 * `V33-DEC-036` R7.
 *
 * ## Under the existing commercial administrator namespace, on the class
 *
 * Mounted at `v1/admin/commercial/booking-credit-enforcement`, with
 * `@RequireCapability('bc_manage_commercial_plans')` on the CLASS exactly as
 * `CommercialCatalogueController` declares it, so every handler is gated and
 * the suite asserts it over the real route table. The capability is in
 * `PRIVILEGED_CAPABILITIES`, so live revocation re-check and the boot-time
 * "every mutation declares an audit action" assertion apply automatically.
 *
 * ## Every mutation body is exactly a reason
 *
 * `ReasonDto` (3-500 characters, trimmed in the service) and nothing else --
 * `forbidNonWhitelisted` rejects any other field, so there is no field through
 * which a caller could name an owner, user, professional, business, party,
 * subscription, grant or quantity. The governance commands are SET-BASED
 * (ADR-050 §5.3); there is no per-seller selector to accept.
 *
 * ## What the reads return, and what they never do
 *
 * Aggregate counts and control state. No `recorded_by_user_id`, no audit id,
 * no party id, no seller-identifying data of any kind -- an operator learns
 * HOW MANY, never WHO. Neither read writes a row or an audit entry.
 *
 * ## What is deliberately absent (story boundary)
 *
 * NO activation route. `POST .../activation` is #141's (`#58b-2`), and a
 * fast test asserts this file declares no such handler. No seller- or
 * customer-facing counterpart exists under `v1/me/*`.
 */
@Controller('v1/admin/commercial/booking-credit-enforcement')
@RequireCapability('bc_manage_commercial_plans')
export class BookingCreditEnforcementController {
  constructor(private readonly governance: BookingCreditEnforcementGovernanceService) {}

  @Get()
  async status() {
    return this.governance.status();
  }

  @Get('preview')
  async preview() {
    return this.governance.preview();
  }

  @Post('transitions')
  @AuditAction(ENFORCEMENT_AUDIT_ACTIONS.partiesGoverned)
  async transition(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReasonDto) {
    return this.governance.transitionEntitledParties(user.userId, dto.reason);
  }

  @Post('exemptions')
  @AuditAction(ENFORCEMENT_AUDIT_ACTIONS.partiesExempted)
  async exempt(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReasonDto) {
    return this.governance.exemptUnentitledParties(user.userId, dto.reason);
  }

  @Post('kill-switch/engage')
  @AuditAction(ENFORCEMENT_AUDIT_ACTIONS.killSwitchEngaged)
  async engage(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReasonDto) {
    return this.governance.engageKillSwitch(user.userId, dto.reason);
  }

  @Post('kill-switch/release')
  @AuditAction(ENFORCEMENT_AUDIT_ACTIONS.killSwitchReleased)
  async release(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReasonDto) {
    return this.governance.releaseKillSwitch(user.userId, dto.reason);
  }
}
