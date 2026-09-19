import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  COMMISSION_COMPONENTS,
  CommissionBase,
  CommissionComponent,
  CommissionRuleKind,
  CommissionTermV1,
} from '@beauclick/commercial-policy-contract';

interface ActiveCommissionVersionRow {
  readonly component: CommissionComponent;
  readonly policy_key: string;
  readonly version: number;
  readonly rule_kind: CommissionRuleKind;
  readonly bp: number | null;
  readonly fixed_toman: string | null;
  readonly base: CommissionBase | null;
  readonly arithmetic_version: number;
}

/**
 * Which commission rule binds an order, resolved inside the ORDER transaction
 * — V3.3 Story #192 (`#43b-2`), ADR-052 §2, ADR-048 §1.
 *
 * A read-only service, for the reason `BookingOutcomePolicyResolutionService`
 * records: no actor, no reason, no audit row and no write, so the order path
 * cannot reach a mutation surface. `#43b-1`'s `CommissionPolicyService` — the
 * administrator's writer — is not on this path and must never be.
 *
 * ## One query, three components, `FOR SHARE`
 *
 * The share lock is the retirement-race boundary (ADR-048 R5): a retirement is
 * an UPDATE of the version row, so it WAITS for any order already holding the
 * share lock, and an order never observes a version retired out from under it
 * mid-transaction. Share locks only, never upgraded, so two concurrent
 * checkouts never block each other.
 *
 * One statement rather than three: the three components are read at one
 * instant, from one snapshot, so a publication committing between two reads
 * cannot produce an order bound by a rate for one component and the previous
 * rate for another. A mixed snapshot is the failure ADR-052 §2's "deterministic"
 * requirement is about, and a single statement is what makes it unrepresentable
 * rather than merely unlikely.
 *
 * ## Absence is an answer
 *
 * A component with no active version resolves to `absent`, which the caller
 * writes explicitly. There is no default rate, no fallback to a previous
 * version and no "latest" — `V33-DEC-040` R1 makes commission a published
 * decision, so the absence of one is a fact about the platform, not a gap for
 * this service to fill.
 *
 * Two active versions for one component is unrepresentable in the database
 * (`uq_cp_component` plus the effective-window exclusion of `#43b-1`), so this
 * service does not carry an `ambiguous` outcome: there is no way to produce
 * one, and an outcome nobody can reach is an outcome nobody tests.
 */
@Injectable()
export class CommissionPolicyResolutionService {
  /**
   * The three terms that bind an order, in ADR-052 §3's fixed component order.
   * Always exactly three entries; a component with no active version is
   * returned as `absent` rather than omitted.
   */
  async resolveForOrder(manager: EntityManager): Promise<CommissionTermV1[]> {
    const rows: ActiveCommissionVersionRow[] = await manager.query(
      `SELECT p.component, v.policy_key, v.version, v.rule_kind, v.bp, v.fixed_toman, v.base, v.arithmetic_version
         FROM commercial.commission_policy_versions v
         JOIN commercial.commission_policies p ON p.policy_key = v.policy_key
        WHERE v.lifecycle_state = 'published'
          AND v.activation_starts_at <= now()
          AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
        FOR SHARE OF v`,
    );

    const byComponent = new Map<CommissionComponent, ActiveCommissionVersionRow>();
    for (const row of rows) byComponent.set(row.component, row);

    return COMMISSION_COMPONENTS.map((component) => {
      const row = byComponent.get(component);
      if (!row) {
        return {
          component,
          state: 'absent' as const,
          policyKey: null,
          policyVersion: null,
          ruleKind: null,
          basisPoints: null,
          fixedToman: null,
          base: null,
          arithmeticVersion: null,
        };
      }

      // A published `zero` is its own state: an administrator decided to
      // charge nothing, which `#43c` must be able to tell apart from nobody
      // having decided at all.
      return {
        component,
        state: row.rule_kind === 'zero' ? ('zero' as const) : ('rule' as const),
        policyKey: row.policy_key,
        policyVersion: row.version,
        ruleKind: row.rule_kind,
        basisPoints: row.bp,
        fixedToman: row.fixed_toman === null ? null : Number(row.fixed_toman),
        base: row.base,
        arithmeticVersion: row.arithmetic_version,
      };
    });
  }
}
