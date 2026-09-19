import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ResolvedSettlementSchedule, SellerRiskClass } from '@beauclick/commercial-policy-contract';

interface ActiveScheduleRow {
  readonly policy_key: string;
  readonly version: number;
  readonly plan_key: string;
  readonly risk_class: SellerRiskClass;
  readonly settlement_interval_days: number;
  readonly minimum_payout_toman: string | null;
  readonly reserve_bp: number | null;
  readonly reserve_cap_toman: string | null;
}

/**
 * Which settlement schedule governs a seller — V3.3 Story #175 (`#43d`),
 * ADR-052 §1 and §8.
 *
 * Read-only, for the reason every resolver in this service is: no actor, no
 * reason, no audit row and no write, so the settlement path `#43e` will build
 * cannot reach a mutation surface.
 *
 * ## The lock order, and why `FOR SHARE`
 *
 *   1. `FOR SHARE` on the party's CURRENT risk class — a re-classification is
 *      an UPDATE of that row, so it waits for a settlement already in flight;
 *   2. `FOR SHARE` on the active schedule VERSION — a retirement waits.
 *
 * Share locks only, never upgraded: two settlements for different sellers
 * never block each other, and an administrator re-classifying waits for
 * in-flight work rather than deadlocking with it. The same order ADR-048 R5
 * fixes and `#43b-2` follows.
 *
 * ## It never guesses a class, and never guesses a cadence
 *
 * `V33-DEC-040` R4 forbids inferring a risk class, so an unclassified seller
 * is `unresolved{no_risk_class}` — not `standard`. A classified seller whose
 * `(plan, class)` pair has no active version is
 * `unresolved{no_active_schedule}` — not a default interval. The two causes
 * are separate members because they are different facts: the first is an
 * operational gap somebody must close, the second a commercial decision
 * nobody has made.
 *
 * Two active versions for one key is unrepresentable (the effective-window
 * exclusion), so there is no `ambiguous` outcome to reach or to test.
 */
@Injectable()
export class SettlementScheduleResolutionService {
  async resolveForParty(
    manager: EntityManager,
    partyType: 'professional' | 'business',
    partyId: string,
    planKey: string,
  ): Promise<ResolvedSettlementSchedule> {
    // (1) The class. Presence IS classification; absence is a fail-closed
    // answer and never a default.
    const classes: Array<{ risk_class: SellerRiskClass }> = await manager.query(
      `SELECT risk_class
         FROM commercial.seller_risk_class_assignments
        WHERE seller_party_type = $1 AND seller_party_id = $2 AND superseded_at IS NULL
        FOR SHARE`,
      [partyType, partyId],
    );
    const assigned = classes[0];
    if (!assigned) return { outcome: 'unresolved', cause: 'no_risk_class' };

    // (2) The schedule active at the database's own clock for this pair, locked.
    const rows: ActiveScheduleRow[] = await manager.query(
      `SELECT v.policy_key, v.version, p.plan_key, p.risk_class,
              v.settlement_interval_days, v.minimum_payout_toman, v.reserve_bp, v.reserve_cap_toman
         FROM commercial.settlement_schedule_policy_versions v
         JOIN commercial.settlement_schedule_policies p ON p.policy_key = v.policy_key
        WHERE p.plan_key = $1 AND p.risk_class = $2
          AND v.lifecycle_state = 'published'
          AND v.activation_starts_at <= now()
          AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
        FOR SHARE OF v`,
      [planKey, assigned.risk_class],
    );
    const row = rows[0];
    if (!row) return { outcome: 'unresolved', cause: 'no_active_schedule' };

    return {
      outcome: 'resolved',
      terms: {
        policyKey: row.policy_key,
        policyVersion: row.version,
        planKey: row.plan_key,
        riskClass: row.risk_class,
        settlementIntervalDays: row.settlement_interval_days,
        minimumPayoutToman: row.minimum_payout_toman === null ? null : Number(row.minimum_payout_toman),
        reserveBasisPoints: row.reserve_bp,
        reserveCapToman: row.reserve_cap_toman === null ? null : Number(row.reserve_cap_toman),
      },
    };
  }
}
