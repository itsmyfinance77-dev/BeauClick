import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import { EmptyBodyDto, EmptyQueryDto, SelectPlanVersionDto } from './seller-subscription-surface.dto';
import {
  HistoryEntry,
  PlanEntry,
  SellerSubscriptionSurfaceService,
  WorkspaceEntry,
} from './seller-subscription-surface.service';

/**
 * The capability a seller needs to CHANGE their own commercial terms.
 *
 * Declared here as a constant rather than typed into four decorators, so the
 * migration that grants it, the role map that carries it and the routes that
 * require it can be checked against one name.
 */
export const MANAGE_OWN_SUBSCRIPTION = 'bc_manage_own_subscription';

/**
 * A seller's own subscriptions — Story #69 (`#56b`), `V33-DEC-019`.
 *
 * ## Why this is a collection and not `GET /me/subscription`
 *
 * `provider.professionals.owner_id` and `business.businesses.owner_id` are
 * independent unique indexes, so one user may own a professional AND a
 * business. A singular route has no answer for such a caller that is not a
 * silent choice, and `V33-DEC-018` forbids every way of making one —
 * first-in-array, business-first, professional-first, staff affiliation, array
 * order, inference from the plan. `V33-DEC-019` therefore rejected the singular
 * contract before it was built, and this is the collection that replaced it.
 *
 * ## The capability is on the MUTATIONS only, and that is not an oversight
 *
 * Reading requires authentication and live ownership. Mutating additionally
 * requires `bc_manage_own_subscription`, declared per handler below.
 *
 * A class-level decorator would have been shorter and would have gated the
 * reads too, which `V33-DEC-019` does not ask for: a seller who can see a
 * workspace at all owns it, and withholding the read would only make the
 * surface unusable for an account whose token predates the capability grant.
 *
 * ## What the capability does NOT do, stated because the opposite is assumed
 *
 * `bc_manage_own_subscription` is NOT in `PRIVILEGED_CAPABILITIES`, so there is
 * no live database re-check on it: it is baked into the access token at issue
 * time and a revoked grant takes effect when the next token is issued, up to
 * the access-token TTL later. That is the honest description and the suite
 * tests exactly that, rather than claiming a revocation guarantee this
 * capability does not carry.
 *
 * It is also not what stops a staff member reaching their employer's
 * subscription. OWNERSHIP does — #56a's resolver deliberately does not follow
 * staff affiliation, so an employee enumerates no parties and a capability
 * check that passed would find nothing to act on. The capability gates the
 * ACTION; ownership decides the WORKSPACE.
 *
 * ## No `@AuditAction`, and the audit is still guaranteed
 *
 * `assertPrivilegedMutationsAreAudited` covers privileged mutations, and this
 * capability is deliberately not one. The audit row is written by
 * `SellerSubscriptionService` inside the same transaction as the subscription
 * and the grant, which is a stronger guarantee than a decorator: the record
 * cannot be missing unless the change is missing too.
 *
 * ## Nothing here names a party
 *
 * There is no `userId`, `ownerId`, `professionalId`, `businessId`, `partyId`,
 * `subscriberId`, `actorId` or `subscriptionId` in any path, query or body on
 * this controller. The caller comes from the session and the workspace from an
 * opaque reference that is matched, never looked up — so cross-party access is
 * not something a check could fail to catch; it is unrepresentable, which is
 * the same construction `MyFinanceController` records.
 */
@Controller('v1/me/subscriptions')
export class SellerSubscriptionSurfaceController {
  constructor(private readonly surface: SellerSubscriptionSurfaceService) {}

  /**
   * `POST /api/v1/me/subscriptions/initialization` — the ONLY route that writes
   * a base workspace.
   *
   * A command, not a read, and it is spelled as a sub-resource rather than as a
   * `POST` to the collection because it creates nothing the caller named: it
   * reconciles every workspace they own to the invariant that an eligible party
   * always has exactly one active subscription.
   *
   * The two empty DTOs are the "no body, no query" contract. Under
   * `forbidNonWhitelisted` they turn any supplied field into a `400` instead of
   * silently ignoring it — see the DTO file for why ignoring would be worse.
   */
  @Post('initialization')
  @RequireCapability(MANAGE_OWN_SUBSCRIPTION)
  async initialize(
    @CurrentUser() user: AuthenticatedUser,
    @Body() _body: EmptyBodyDto,
    @Query() _query: EmptyQueryDto,
  ): Promise<{ items: WorkspaceEntry[] }> {
    return { items: await this.surface.initialize(user.userId) };
  }

  /**
   * `GET /api/v1/me/subscriptions`.
   *
   * Side-effect-free. An empty collection for a caller who owns no seller
   * workspace — never a `404`, which would conflate "you are not a seller" with
   * "no such route".
   */
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() _query: EmptyQueryDto,
  ): Promise<{ items: WorkspaceEntry[] }> {
    return { items: await this.surface.list(user.userId) };
  }

  /** `GET /api/v1/me/subscriptions/:workspaceRef/history` — newest first, one workspace, side-effect-free. */
  @Get(':workspaceRef/history')
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyQueryDto,
  ): Promise<{ items: HistoryEntry[] }> {
    return { items: await this.surface.history(user.userId, workspaceRef) };
  }

  /**
   * `POST /api/v1/me/subscriptions/:workspaceRef/selection`.
   *
   * `{ planKey, version }` and nothing else. The workspace is the path segment
   * and the actor is the session, so neither can be supplied and neither has to
   * be ignored.
   */
  @Post(':workspaceRef/selection')
  @RequireCapability(MANAGE_OWN_SUBSCRIPTION)
  async select(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Body() dto: SelectPlanVersionDto,
    @Query() _query: EmptyQueryDto,
  ): Promise<WorkspaceEntry> {
    return this.surface.select(user.userId, workspaceRef, dto.planKey, dto.version);
  }

  /**
   * `POST /api/v1/me/subscriptions/:workspaceRef/cancellation`.
   *
   * No body, no query. Returns the workspace as it stands afterwards — which
   * for a party already on the base workspace is the workspace unchanged, with
   * nothing written and nothing audited.
   */
  @Post(':workspaceRef/cancellation')
  @RequireCapability(MANAGE_OWN_SUBSCRIPTION)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Body() _body: EmptyBodyDto,
    @Query() _query: EmptyQueryDto,
  ): Promise<WorkspaceEntry> {
    return this.surface.cancel(user.userId, workspaceRef);
  }
}

/**
 * The seller-visible plan catalogue — `GET /api/v1/me/commercial-plans`.
 *
 * ## A separate controller because it is a separate resource
 *
 * The catalogue is not a sub-resource of a seller's subscriptions: it is the
 * same for every seller, it names no workspace, and mounting it under
 * `/me/subscriptions` would imply a scoping it does not have.
 *
 * ## Authenticated, and that is a deliberate choice rather than a default
 *
 * `V33-DEC-019` specifies a seller-facing route. The prices and entitlements
 * here are published commitments and not secrets, but an unauthenticated
 * catalogue is a public statement about commercial terms while #46 is still
 * open — so it stays behind a session, which costs a signed-out visitor
 * nothing and commits the platform to nothing.
 *
 * ## No capability
 *
 * Reading what a seller MAY subscribe to is not managing a subscription, and
 * requiring `bc_manage_own_subscription` here would hide the catalogue from a
 * customer deciding whether to become a seller.
 *
 * ## What it excludes
 *
 * Drafts, retired versions, versions whose activation window has not opened and
 * versions whose window has closed — each absent for the same reason, so their
 * absence discloses nothing. No `createdByUserId`, `publishedByUserId` or
 * `retiredByUserId`: who at the platform published a plan is an administrative
 * fact for the audit log, the same line `CommercialCatalogueController` draws.
 * No unpublished schedule, and no audit internals of any kind.
 */
@Controller('v1/me/commercial-plans')
export class SellerCommercialPlansController {
  constructor(private readonly surface: SellerSubscriptionSurfaceService) {}

  @Get()
  async list(
    @CurrentUser() _user: AuthenticatedUser,
    @Query() _query: EmptyQueryDto,
  ): Promise<{ items: PlanEntry[] }> {
    return { items: await this.surface.plans() };
  }
}
