import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import {
  CommercialPlanVersionEntity,
  CommercialPriceScheduleVersionEntity,
  CommercialPriceTierEntity,
} from '../catalogue/commercial-catalogue.entities';
import {
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from '../subscription/owned-subscriber-party.port';
import { SellerSubscriptionEntity } from '../subscription/seller-subscription.entities';
import { SellerSubscriptionService } from '../subscription/seller-subscription.service';
import {
  SubscriptionNotConfiguredException,
  SubscriptionSelectionAlreadyAppliedException,
  SubscriptionSellerNotEligibleException,
} from '../subscription/seller-subscription.exceptions';
import { WorkspaceReferenceService } from './workspace-reference';

/**
 * The seller-facing subscription surface — Story #69 (`#56b`), `V33-DEC-019`.
 *
 * ## What this class adds to `#56a`, and what it deliberately does not
 *
 * `SellerSubscriptionService` already owns the lifecycle: assignment,
 * selection, cancellation, snapshots, grants and audit, each inside one
 * transaction. This class adds the three things a ROUTE needs and a domain
 * service must not have — resolving the caller's owned workspaces, translating
 * an opaque reference into one of them, and projecting rows into a
 * seller-safe shape.
 *
 * It implements no lifecycle rule of its own. Anywhere it looks like it does,
 * that is a bug: a second implementation of "what happens when a seller
 * cancels" is exactly what `V33-DEC-019` split this story to avoid.
 *
 * ## Ordering is decided HERE, and it decides nothing else
 *
 * Entries are sorted by `(partyType, partyId)`. Deterministic, so a client
 * rendering a list gets a stable order across calls and a test can assert a
 * whole response body — and it is sorted here rather than inherited from the
 * ownership resolver so that changing the resolver cannot silently reorder a
 * seller's workspaces.
 *
 * Ordering never selects a workspace. Every mutation names one by reference,
 * and `V33-DEC-018` forbids first-in-array, business-first, professional-first
 * and every other implicit choice — which is the whole reason this surface is a
 * collection instead of `GET /me/subscription`.
 *
 * ## Nothing here logs, and that is a requirement rather than an omission
 *
 * There is no logger in this file. `workspaceReferenceInput` contains the
 * owner's user id and the raw party id, the secret is never read outside
 * `WorkspaceReferenceService`, and a `workspaceRef` in a log line or a metric
 * label would be a per-seller high-cardinality identifier attached to
 * everything else in the record. The boundary suite asserts the absence.
 */
@Injectable()
export class SellerSubscriptionSurfaceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly subscriptions: SellerSubscriptionService,
    private readonly references: WorkspaceReferenceService,
    @Inject(OWNED_SUBSCRIBER_PARTY_RESOLVER)
    private readonly parties: OwnedSubscriberPartyResolver,
  ) {}

  // ========================================================================
  // Initialization — the only path that ensures a base workspace
  // ========================================================================

  /**
   * `POST /me/subscriptions/initialization`.
   *
   * Ensures the base workspace for EVERY party the caller owns, and returns the
   * resulting collection.
   *
   * ## One transaction for every workspace, not one per workspace
   *
   * A dual owner's two ensures share this transaction, so a failure on the
   * second leaves neither subscription, neither grant and neither audit row.
   * Partial initialization would be the worse outcome by far: a seller with one
   * workspace configured and one not, whose retry then behaves differently for
   * each half.
   *
   * The ownership enumeration runs inside it too — the port takes the caller's
   * `EntityManager` precisely so it cannot open its own connection and see a
   * different world from the writes it is about to authorise (ADR-042 §9).
   *
   * ## Replay writes nothing
   *
   * `ensureBaseSubscriptionWithin` returns the existing active subscription
   * when there is one, without an insert, an audit row or a grant. So a second
   * call is a read that happens to be a POST, and the `V33-DEC-019` requirement
   * that replay write nothing is a property of #56a's ensure rather than of a
   * check added here.
   *
   * ## Concurrency
   *
   * Two simultaneous initializations both find nothing and both insert;
   * `uq_seller_subscriptions_one_active_per_party` refuses one, the loser
   * re-reads the winner's row, and both callers get the same collection. The
   * INDEX is the guarantee — never an application-level check, which cannot
   * survive read-committed (ADR-042 §4).
   */
  async initialize(userId: string): Promise<WorkspaceEntry[]> {
    return this.dataSource.transaction(async (manager) => {
      const parties = await this.ownedParties(manager, userId);

      const entries: WorkspaceEntry[] = [];
      for (const party of parties) {
        // Sequential, not `Promise.all`. Every statement here runs on ONE
        // connection, and concurrent statements on a single TypeORM
        // transaction interleave onto it in an order nothing controls.
        const subscription = await this.subscriptions.ensureBaseSubscriptionWithin(manager, party);
        entries.push(await this.toEntry(manager, userId, party, subscription));
      }
      return entries;
    });
  }

  // ========================================================================
  // Reads — side-effect free
  // ========================================================================

  /**
   * `GET /me/subscriptions`.
   *
   * One entry per owned workspace. A caller who owns none receives an empty
   * array, never a `404`: owning no seller workspace is a legitimate state for
   * an authenticated customer, and a `404` would make "you are not a seller"
   * indistinguishable from "that route does not exist".
   *
   * ## It does NOT ensure a base workspace, and that is the story's boundary
   *
   * A workspace with no active subscription appears with a null subscription
   * rather than being quietly given one. `V33-DEC-019` makes initialization the
   * only path that writes, so this route cannot create a subscription, a grant
   * or an audit row — and a reviewer can check that against the absence of any
   * `ensure` call below rather than against intention.
   */
  async list(userId: string): Promise<WorkspaceEntry[]> {
    const manager = this.dataSource.manager;
    const parties = await this.ownedParties(manager, userId);

    const entries: WorkspaceEntry[] = [];
    for (const party of parties) {
      const active = await this.subscriptions.findActive(party, manager);
      entries.push(await this.toEntry(manager, userId, party, active));
    }
    return entries;
  }

  /**
   * `GET /me/subscriptions/:workspaceRef/history`.
   *
   * The immutable chain for ONE owned workspace, newest first.
   *
   * ## Unpaginated, deliberately
   *
   * Every other `/v1/me` collection in this repository — finance settlements,
   * loyalty entries, notifications — returns its rows unpaginated, and the
   * chain here is bounded by the seller's own selections and cancellations
   * rather than by anything a third party can drive. Adding page parameters
   * would also add query fields to a route whose contract is "no query fields",
   * so the repository convention and the story's own contract agree.
   *
   * ## Cross-workspace leakage is unrepresentable, not merely refused
   *
   * `historyFor` is keyed by PARTY, and the party came from matching the
   * reference against what this caller owns. There is no query anywhere on this
   * path that takes a user id and returns subscriptions, so a dual owner's two
   * chains cannot be joined by a mistake here.
   */
  async history(userId: string, workspaceRef: string): Promise<HistoryEntry[]> {
    const manager = this.dataSource.manager;
    const party = await this.resolveOwnedWorkspace(manager, userId, workspaceRef);
    const chain = await this.subscriptions.historyFor(party);
    return chain.map((row) => this.toHistoryEntry(row));
  }

  /**
   * `GET /me/commercial-plans`.
   *
   * The published, currently-effective catalogue as a seller may see it.
   *
   * ## Two live conditions, and no fallback
   *
   * A version appears when it is `published` AND now falls inside its
   * activation window. Drafts, retired versions, versions whose window has not
   * opened and versions whose window has closed are all absent — and absent for
   * the same reason, so a seller cannot tell which by what they receive. This
   * is the same predicate `CommercialCatalogueService.resolveActivePlanVersion`
   * applies to a single key, which is why a version that shows here is a
   * version selection will accept (ADR-041 §5).
   *
   * ## ONE query, whatever the catalogue's size
   *
   * The price lives two tables away — a plan version points at a price schedule
   * version, whose tiers carry the money — and the obvious shape is a loop that
   * reads them per plan. That is an N+1 whose cost is invisible with the three
   * plans a test seeds and linear with the catalogue an administrator actually
   * publishes.
   *
   * The joins below collapse it to a single statement, and the suite pins that
   * by running the route against one plan and against several and asserting the
   * query count is IDENTICAL — a stronger control than a magic number, because
   * it fails on the growth rather than on the constant.
   *
   * A `seller_plan` schedule prices exactly one subscription, so the tier
   * covering quantity 1 is the price; the join says so rather than a comment.
   */
  async plans(): Promise<PlanEntry[]> {
    const now = new Date();

    const rows: RawPlanRow[] = await this.dataSource
      .getRepository(CommercialPlanVersionEntity)
      .createQueryBuilder('v')
      .innerJoin(CommercialPriceScheduleVersionEntity, 'sv', 'sv.id = v.price_schedule_version_id')
      .innerJoin(
        CommercialPriceTierEntity,
        't',
        't.schedule_version_id = sv.id AND t.min_quantity <= 1 AND (t.max_quantity IS NULL OR t.max_quantity >= 1)',
      )
      .where("v.lifecycle_state = 'published'")
      .andWhere('v.activation_starts_at <= :now', { now })
      .andWhere('(v.activation_ends_at IS NULL OR v.activation_ends_at > :now)', { now })
      .select([
        'v.plan_key AS plan_key',
        'v.version AS version',
        'v.display_name AS display_name',
        'v.billing_term_days AS billing_term_days',
        'v.included_booking_credits AS included_booking_credits',
        'v.staff_seats AS staff_seats',
        'v.included_locations AS included_locations',
        'v.capability_keys AS capability_keys',
        'v.auto_assignable AS auto_assignable',
        'sv.currency_code AS currency_code',
        't.unit_price_toman AS unit_price_toman',
      ])
      // Deterministic and asserted. `plan_key` then `version` is the order an
      // administrator publishes in and the order a catalogue reads in.
      .orderBy('v.plan_key', 'ASC')
      .addOrderBy('v.version', 'ASC')
      .getRawMany();

    return rows.map((row) => {
      const unitPriceToman = Number(row.unit_price_toman);
      return {
        planKey: row.plan_key,
        version: row.version,
        displayName: row.display_name,
        billingTermDays: row.billing_term_days,
        entitlements: {
          includedBookingCredits: row.included_booking_credits,
          staffSeats: row.staff_seats,
          includedLocations: row.included_locations,
          capabilityKeys: row.capability_keys,
        },
        price: { currency: row.currency_code, unitPriceToman },
        baseWorkspace: row.auto_assignable,
        /*
         * The honest half of "a non-zero version may be VISIBLE but cannot be
         * SELECTED" (`V33-DEC-018`, #47).
         *
         * Stated as a field rather than left for the seller to infer from the
         * price, because the reason a paid plan cannot be activated is a
         * platform fact — no settlement rail exists — and not a property of the
         * plan. Hiding it would leave a seller unable to tell a permanent
         * refusal from a transient one, which is the same reasoning
         * `SubscriptionPaidActivationUnavailableException` records.
         */
        selectable: unitPriceToman === 0,
      };
    });
  }

  // ========================================================================
  // Mutations
  // ========================================================================

  /**
   * `POST /me/subscriptions/:workspaceRef/selection`.
   *
   * The refusal for a replay is raised HERE rather than in the domain service,
   * because `selectPlanVersion` returning the active row on a replay is #56a's
   * documented contract and its suite asserts it. The route's contract is
   * different — `V33-DEC-019` requires `selection_already_applied` — and the
   * two are reconciled by `applyPlanSelection` reporting which occurred.
   */
  async select(
    userId: string,
    workspaceRef: string,
    planKey: string,
    version: number,
  ): Promise<WorkspaceEntry> {
    const manager = this.dataSource.manager;
    const party = await this.resolveOwnedWorkspace(manager, userId, workspaceRef);

    const result = await this.subscriptions.applyPlanSelection(party, planKey, version, userId);
    if (result.outcome === 'already_applied') throw new SubscriptionSelectionAlreadyAppliedException();

    return this.toEntry(manager, userId, party, result.subscription);
  }

  /**
   * `POST /me/subscriptions/:workspaceRef/cancellation`.
   *
   * Cancelling while the base workspace is already active returns the unchanged
   * workspace with no refusal and no write — see `applyCancellation` for why
   * that is an outcome rather than an error.
   */
  async cancel(userId: string, workspaceRef: string): Promise<WorkspaceEntry> {
    const manager = this.dataSource.manager;
    const party = await this.resolveOwnedWorkspace(manager, userId, workspaceRef);

    const result = await this.subscriptions.applyCancellation(party, userId);
    return this.toEntry(manager, userId, party, result.subscription);
  }

  // ========================================================================
  // Internals
  // ========================================================================

  /**
   * The caller's owned parties, in the surface's own deterministic order.
   *
   * Ownership ONLY. #56a's resolver deliberately does not follow staff
   * affiliation, so an employee of a business gets an empty array here and
   * their employer's workspace never appears in their collection — which is
   * what actually stops them reading or mutating it. The capability is a second
   * lock on a door this list already refuses to open.
   */
  private async ownedParties(manager: EntityManager, userId: string): Promise<OwnedSubscriberParty[]> {
    const parties = await this.parties.ownedPartiesFor(manager, userId);
    return [...parties].sort(
      (left, right) =>
        left.partyType.localeCompare(right.partyType) || left.partyId.localeCompare(right.partyId),
    );
  }

  /**
   * A caller-supplied reference, turned into a party they own RIGHT NOW.
   *
   * Enumerate, recompute, compare — never look up. Every failure produces one
   * `SubscriptionSellerNotEligibleException`: malformed, foreign, stale,
   * unknown, and "you own no seller workspace" are one status, one code, one
   * message and one body, so nothing here can be used to learn whether a
   * professional or business exists, whether it belongs to somebody else,
   * whether the reference was correctly signed, or whether a subscription
   * stands behind it.
   */
  private async resolveOwnedWorkspace(
    manager: EntityManager,
    userId: string,
    workspaceRef: string,
  ): Promise<OwnedSubscriberParty> {
    const parties = await this.ownedParties(manager, userId);
    if (parties.length === 0) throw new SubscriptionSellerNotEligibleException();
    return this.references.resolve(userId, parties, workspaceRef);
  }

  /**
   * The seller-safe projection of one workspace.
   *
   * ## What it cannot contain
   *
   * No `subscriberPartyId`, no `ownerId`, no `userId`, no subscription id, no
   * plan-version id, no `createdByUserId`, no `cancelledByUserId`, no audit id
   * and no audit reason. The workspace is named by its reference and the terms
   * by their catalogue coordinates, so there is no field into which a raw
   * identifier could be added without a reviewer seeing it.
   *
   * `workspaceType` is the party TYPE — a two-valued classification a seller
   * already knows about their own business, carrying no identity.
   */
  private async toEntry(
    manager: EntityManager,
    userId: string,
    party: OwnedSubscriberParty,
    subscription: SellerSubscriptionEntity | null,
  ): Promise<WorkspaceEntry> {
    const baseWorkspace = subscription === null ? false : await this.isBaseVersion(manager, subscription);

    return {
      workspaceRef: this.references.referenceFor(userId, party),
      workspaceType: party.partyType,
      subscription:
        subscription === null
          ? null
          : {
              state: subscription.lifecycleState,
              plan: {
                planKey: subscription.snapshotPlanKey,
                version: subscription.snapshotVersion,
                billingTermDays: subscription.snapshotBillingTermDays,
              },
              entitlements: {
                includedBookingCredits: subscription.snapshotIncludedBookingCredits,
                staffSeats: subscription.snapshotStaffSeats,
                includedLocations: subscription.snapshotIncludedLocations,
                capabilityKeys: subscription.snapshotCapabilityKeys,
              },
              price: {
                currency: subscription.snapshotCurrencyCode,
                unitPriceToman: subscription.snapshotUnitPriceToman,
              },
              effectiveAt: subscription.effectiveAt.toISOString(),
            },
      baseWorkspace,
      /*
       * "Whether a seller action is currently available", as `V33-DEC-019` puts
       * it, computed from state rather than asserted.
       *
       * `cancel` is absent when the party is already on the base workspace,
       * because cancelling there changes nothing — the same fact
       * `applyCancellation` acts on, so the button a client renders and the
       * outcome the server produces cannot disagree.
       */
      availableActions: subscription === null ? [] : baseWorkspace ? ['select_plan'] : ['select_plan', 'cancel'],
    };
  }

  /** One immutable link in the chain. Terms and timestamps; no identity of any kind. */
  private toHistoryEntry(row: SellerSubscriptionEntity): HistoryEntry {
    return {
      state: row.lifecycleState,
      plan: { planKey: row.snapshotPlanKey, version: row.snapshotVersion },
      entitlements: {
        includedBookingCredits: row.snapshotIncludedBookingCredits,
        staffSeats: row.snapshotStaffSeats,
        includedLocations: row.snapshotIncludedLocations,
        capabilityKeys: row.snapshotCapabilityKeys,
      },
      price: { currency: row.snapshotCurrencyCode, unitPriceToman: row.snapshotUnitPriceToman },
      effectiveAt: row.effectiveAt.toISOString(),
      supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    };
  }

  /**
   * Whether a subscription is the base workspace.
   *
   * Read from `plan_versions.auto_assignable`, the mechanism ADR-041 §6 defines
   * the base workspace by — never by comparing a plan key against `D-7`, which
   * appears in no production code.
   */
  private async isBaseVersion(manager: EntityManager, subscription: SellerSubscriptionEntity): Promise<boolean> {
    const version = await manager
      .getRepository(CommercialPlanVersionEntity)
      .findOne({ where: { id: subscription.planVersionId }, select: { id: true, autoAssignable: true } });

    if (!version) {
      // The snapshot survives its catalogue row by design, but a subscription
      // pointing at a version that does not exist is a broken invariant rather
      // than a state to render. Refusing is the honest answer and it names the
      // platform, not the seller.
      throw new SubscriptionNotConfiguredException(
        'the active subscription references a plan version that no longer exists',
      );
    }
    return version.autoAssignable;
  }
}

// ---------------------------------------------------------------------------
// The browser contract
// ---------------------------------------------------------------------------

/**
 * One owned seller workspace.
 *
 * `workspaceRef` is OPAQUE. It is issued by the server, it is not constructible
 * or interpretable by a client, it is not an authorization token, and it stops
 * working when the party stops being owned or the secret is rotated. A client
 * that stores one should treat it as a routing handle valid for as long as the
 * collection it came from.
 */
export interface WorkspaceEntry {
  workspaceRef: string;
  workspaceType: 'professional' | 'business';
  subscription: {
    state: string;
    plan: { planKey: string; version: number; billingTermDays: number | null };
    entitlements: {
      includedBookingCredits: number;
      staffSeats: number;
      includedLocations: number;
      capabilityKeys: string[];
    };
    price: { currency: string; unitPriceToman: number };
    effectiveAt: string;
  } | null;
  baseWorkspace: boolean;
  availableActions: string[];
}

export interface HistoryEntry {
  state: string;
  plan: { planKey: string; version: number };
  entitlements: {
    includedBookingCredits: number;
    staffSeats: number;
    includedLocations: number;
    capabilityKeys: string[];
  };
  price: { currency: string; unitPriceToman: number };
  effectiveAt: string;
  supersededAt: string | null;
  cancelledAt: string | null;
}

export interface PlanEntry {
  planKey: string;
  version: number;
  displayName: string;
  billingTermDays: number | null;
  entitlements: {
    includedBookingCredits: number;
    staffSeats: number;
    includedLocations: number;
    capabilityKeys: string[];
  };
  price: { currency: string; unitPriceToman: number };
  baseWorkspace: boolean;
  selectable: boolean;
}

/** The raw shape of the single catalogue query above. */
interface RawPlanRow {
  plan_key: string;
  version: number;
  display_name: string;
  billing_term_days: number | null;
  included_booking_credits: number;
  staff_seats: number;
  included_locations: number;
  capability_keys: string[];
  auto_assignable: boolean;
  currency_code: string;
  unit_price_toman: string | number;
}
