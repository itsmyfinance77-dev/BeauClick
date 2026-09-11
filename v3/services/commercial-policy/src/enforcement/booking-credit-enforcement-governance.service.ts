import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import type { SubscriberPartyType } from '@beauclick/commercial-policy-contract';

import { CommercialReasonRequiredException } from '../catalogue/commercial-catalogue.exceptions';
import { BOOKING_ENTITLEMENT_LOCK_NAMESPACE } from '../subscription/booking-credit-accounting.service';
import { BookingCreditEnforcementControlService, EnforcementControlMalformedError } from './booking-credit-enforcement-control.service';
import {
  AUDIT_TARGET_ENFORCEMENT,
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY,
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE,
  ELIGIBLE_PARTIES_SQL,
  ENFORCEMENT_AUDIT_ACTIONS,
} from './booking-credit-enforcement.constants';
import {
  BookingCreditPartyGovernanceEntity,
  ENFORCEMENT_CONTROL_SINGLETON_ID,
  EnforcementRolloutState,
  KillSwitchState,
  PartyGovernanceState,
} from './booking-credit-enforcement.entities';

/** ADR-050 §5.4 -- the preview contract, verbatim. Aggregates only. */
export interface EnforcementPreview {
  readonly rolloutState: EnforcementRolloutState;
  readonly killSwitchState: KillSwitchState;
  readonly activationGeneration: number;
  readonly eligible: number;
  readonly governed: number;
  readonly legacyExempt: number;
  readonly unresolved: number;
  readonly wouldBeRefused: number;
}

/** The control read -- ADR-050 §5.2 `GET`. No audit id, no actor, no party. */
export interface EnforcementStatus {
  readonly rolloutState: EnforcementRolloutState;
  readonly killSwitchState: KillSwitchState;
  readonly activationGeneration: number;
  readonly activatedAt: string | null;
  readonly killSwitchChangedAt: string | null;
}

/** What a set-based command did. Counts only, never a party. */
export interface GovernanceCommandOutcome {
  readonly affected: number;
  readonly skipped: number;
}

interface PartyRow {
  party_type: SubscriberPartyType;
  party_id: string;
}

interface TransitionCandidate extends PartyRow {
  governance_id: string | null;
  state: PartyGovernanceState | null;
  proof_grant_id: string | null;
}

interface PartitionRow {
  eligible: number;
  governed: number;
  legacy_exempt: number;
  unresolved: number;
  would_be_refused: number;
}

const REASON_MIN = 3;
const REASON_MAX = 500;

/**
 * Governance of seller parties and the emergency kill switch -- V3.3 #95
 * (`#58b-1`), ADR-050 §3, §5, §6 and §7.
 *
 * ## Set-based, and no per-seller selector
 *
 * Both governance commands act on a predicate, never on a named seller
 * (ADR-050 §5.3): the owner-bound `workspaceRef` cannot be derived by an
 * administrator, and the two predicates below PARTITION the unresolved set --
 * every unresolved eligible party either holds a positive grant (transition)
 * or does not (exemption) -- so the pair resolves every seller with no
 * targeting at all. A body carries a reason and nothing else.
 *
 * ## Lock order, per ADR-050 §7.2 as implemented
 *
 *   transition / exemption: bcgv SHARED -> control row FOR SHARE ->
 *                           bcre(party) in (party_type, party_id) order ->
 *                           governance write
 *   kill switch:            control row FOR UPDATE -> control update
 *   preview:                no lock of any kind
 *
 * The control row is taken BEFORE the per-party lock everywhere, matching the
 * confirmation path (order -> booking -> control FOR SHARE -> bcre), so no
 * two operations ever acquire the two in opposite orders.
 *
 * ## Plan under the locks, audit once, then write
 *
 * A set-based command first takes every lock and decides what it will do,
 * then writes ONE audit row carrying the counts, then writes the governance
 * rows pointing at that audit id. Nothing can change between the plan and the
 * writes because the locks are held across all three, and a command that
 * finds nothing to do writes nothing -- not even an audit row -- so a replay
 * is a genuine no-op.
 */
@Injectable()
export class BookingCreditEnforcementGovernanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    private readonly control: BookingCreditEnforcementControlService,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async status(): Promise<EnforcementStatus> {
    const row = await this.control.read(this.dataSource.manager);
    return {
      rolloutState: row.rolloutState,
      killSwitchState: row.killSwitchState,
      activationGeneration: row.activationGeneration,
      activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
      killSwitchChangedAt: row.killSwitchChangedAt ? row.killSwitchChangedAt.toISOString() : null,
    };
  }

  /**
   * ADR-050 §5.4. One `REPEATABLE READ` snapshot, two statements, no lock, no
   * write, no audit row -- however many sellers exist.
   */
  async preview(): Promise<EnforcementPreview> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      const row = await this.control.read(manager);
      const partition = await this.partition(manager);
      return {
        rolloutState: row.rolloutState,
        killSwitchState: row.killSwitchState,
        activationGeneration: row.activationGeneration,
        ...partition,
      };
    });
  }

  /**
   * The eligibility/governance partition -- ADR-050 §3.2 and §5.4 -- as ONE
   * set-based statement, shared by preview and (later) activation.
   *
   * `wouldBeRefused` is the ADR-046 §1 arithmetic: positive grants minus
   * consumptions that have no return, per governed party, at or below zero --
   * including a governed party that has never held a positive grant at all.
   */
  async partition(manager: EntityManager): Promise<Pick<EnforcementPreview, 'eligible' | 'governed' | 'legacyExempt' | 'unresolved' | 'wouldBeRefused'>> {
    const [row]: PartitionRow[] = await manager.query(`
      WITH eligible AS (${ELIGIBLE_PARTIES_SQL}),
      positive AS (
        SELECT subscriber_party_type AS party_type, subscriber_party_id AS party_id, sum(quantity)::bigint AS granted
          FROM commercial.booking_credit_grants
         WHERE quantity > 0
         GROUP BY 1, 2
      ),
      spent AS (
        SELECT c.subscriber_party_type AS party_type, c.subscriber_party_id AS party_id, count(*)::bigint AS consumed
          FROM commercial.booking_credit_consumptions c
          LEFT JOIN commercial.booking_credit_returns r ON r.consumption_id = c.id
         WHERE r.id IS NULL
         GROUP BY 1, 2
      )
      SELECT count(*)::int AS eligible,
             count(*) FILTER (WHERE g.state = 'governed')::int AS governed,
             count(*) FILTER (WHERE g.state = 'legacy_exempt')::int AS legacy_exempt,
             count(*) FILTER (WHERE g.id IS NULL)::int AS unresolved,
             count(*) FILTER (WHERE g.state = 'governed'
                                AND coalesce(p.granted, 0) - coalesce(s.consumed, 0) <= 0)::int AS would_be_refused
        FROM eligible e
        LEFT JOIN commercial.booking_credit_party_governance g
               ON g.party_type = e.party_type AND g.party_id = e.party_id
        LEFT JOIN positive p ON p.party_type = e.party_type AND p.party_id = e.party_id
        LEFT JOIN spent s ON s.party_type = e.party_type AND s.party_id = e.party_id`);
    return {
      eligible: row.eligible,
      governed: row.governed,
      legacyExempt: row.legacy_exempt,
      unresolved: row.unresolved,
      wouldBeRefused: row.would_be_refused,
    };
  }

  // =========================================================================
  // Explicit transition and exemption (ADR-050 §3.3)
  // =========================================================================

  /**
   * Governs every eligible party that is unresolved or `legacy_exempt` AND
   * holds at least one immutable grant with `quantity > 0`, recording the
   * oldest such grant (`granted_at ASC, id ASC`) as the proof. Parties without
   * a positive grant are counted as skipped and left exactly as they are.
   * Writes no grant, subscription, consumption, return or balance.
   */
  async transitionEntitledParties(actorUserId: string, reason: string): Promise<GovernanceCommandOutcome> {
    const statedReason = this.requireReason(reason);

    return this.dataSource.transaction(async (manager) => {
      await this.takeCoordinationShared(manager);
      await this.control.readForConfirmation(manager);

      const candidates: TransitionCandidate[] = await manager.query(`
        WITH eligible AS (${ELIGIBLE_PARTIES_SQL})
        SELECT e.party_type, e.party_id, g.id AS governance_id, g.state,
               (SELECT gr.id
                  FROM commercial.booking_credit_grants gr
                 WHERE gr.subscriber_party_type = e.party_type
                   AND gr.subscriber_party_id = e.party_id
                   AND gr.quantity > 0
                 ORDER BY gr.granted_at ASC, gr.id ASC
                 LIMIT 1) AS proof_grant_id
          FROM eligible e
          LEFT JOIN commercial.booking_credit_party_governance g
                 ON g.party_type = e.party_type AND g.party_id = e.party_id
         WHERE g.id IS NULL OR g.state = 'legacy_exempt'
         ORDER BY e.party_type, e.party_id`);

      // Phase 1 -- lock each entitled party in the fixed order and re-decide
      // under the lock. A concurrent batch that got there first has already
      // governed the party; this one then finds it governed and skips.
      const plan: TransitionCandidate[] = [];
      let skipped = 0;
      for (const candidate of candidates) {
        if (!candidate.proof_grant_id) {
          skipped += 1;
          continue;
        }
        await this.lockParty(manager, candidate);
        const current = await manager.getRepository(BookingCreditPartyGovernanceEntity).findOne({
          where: { partyType: candidate.party_type, partyId: candidate.party_id },
        });
        if (current && current.state === 'governed') continue;
        plan.push({ ...candidate, governance_id: current?.id ?? null, state: current?.state ?? null });
      }

      if (plan.length === 0) return { affected: 0, skipped };

      // Phase 2 -- one audit row for the command, carrying only counts.
      const auditId = await this.audit.record(manager, {
        actorUserId,
        action: ENFORCEMENT_AUDIT_ACTIONS.partiesGoverned,
        targetType: AUDIT_TARGET_ENFORCEMENT,
        targetId: 'booking_credit_party_governance',
        reason: statedReason,
        after: { affected: plan.length, skipped },
      });

      // Phase 3 -- the writes, pointing at that audit row.
      const now = new Date();
      for (const party of plan) {
        if (party.governance_id) {
          // The one permitted update shape (legacy_exempt -> governed).
          await manager
            .createQueryBuilder()
            .update(BookingCreditPartyGovernanceEntity)
            .set({
              state: 'governed',
              cause: 'explicit_transition',
              governedAt: now,
              proofGrantId: party.proof_grant_id,
              recordedByUserId: actorUserId,
              recordedByLabel: null,
              auditId,
            })
            .where('id = :id', { id: party.governance_id })
            .execute();
        } else {
          await manager.insert(BookingCreditPartyGovernanceEntity, {
            id: uuidv7(),
            partyType: party.party_type,
            partyId: party.party_id,
            state: 'governed',
            cause: 'explicit_transition',
            proofGrantId: party.proof_grant_id,
            governedAt: now,
            recordedByUserId: actorUserId,
            recordedByLabel: null,
            auditId,
          });
        }
      }

      return { affected: plan.length, skipped };
    });
  }

  /**
   * Records `legacy_exempt` for every eligible UNRESOLVED party that holds no
   * positive grant. A party with a positive grant is already selectively
   * enforced by #58a and belongs to the transition command; it is counted as
   * skipped here. A party that already has a row of either state is neither
   * affected nor skipped -- it is resolved.
   */
  async exemptUnentitledParties(actorUserId: string, reason: string): Promise<GovernanceCommandOutcome> {
    const statedReason = this.requireReason(reason);

    return this.dataSource.transaction(async (manager) => {
      await this.takeCoordinationShared(manager);
      await this.control.readForConfirmation(manager);

      const candidates: Array<PartyRow & { has_positive_grant: boolean }> = await manager.query(`
        WITH eligible AS (${ELIGIBLE_PARTIES_SQL})
        SELECT e.party_type, e.party_id,
               EXISTS (SELECT 1 FROM commercial.booking_credit_grants gr
                        WHERE gr.subscriber_party_type = e.party_type
                          AND gr.subscriber_party_id = e.party_id
                          AND gr.quantity > 0) AS has_positive_grant
          FROM eligible e
          LEFT JOIN commercial.booking_credit_party_governance g
                 ON g.party_type = e.party_type AND g.party_id = e.party_id
         WHERE g.id IS NULL
         ORDER BY e.party_type, e.party_id`);

      const plan: PartyRow[] = [];
      let skipped = 0;
      for (const candidate of candidates) {
        if (candidate.has_positive_grant) {
          skipped += 1;
          continue;
        }
        await this.lockParty(manager, candidate);
        const current = await manager.getRepository(BookingCreditPartyGovernanceEntity).count({
          where: { partyType: candidate.party_type, partyId: candidate.party_id },
        });
        if (current > 0) continue;
        plan.push(candidate);
      }

      if (plan.length === 0) return { affected: 0, skipped };

      const auditId = await this.audit.record(manager, {
        actorUserId,
        action: ENFORCEMENT_AUDIT_ACTIONS.partiesExempted,
        targetType: AUDIT_TARGET_ENFORCEMENT,
        targetId: 'booking_credit_party_governance',
        reason: statedReason,
        after: { affected: plan.length, skipped },
      });

      for (const party of plan) {
        await manager.insert(BookingCreditPartyGovernanceEntity, {
          id: uuidv7(),
          partyType: party.party_type,
          partyId: party.party_id,
          state: 'legacy_exempt',
          cause: 'explicit_exemption',
          proofGrantId: null,
          governedAt: null,
          recordedByUserId: actorUserId,
          recordedByLabel: null,
          auditId,
        });
      }

      return { affected: plan.length, skipped };
    });
  }

  // =========================================================================
  // Kill switch (ADR-050 §6)
  // =========================================================================

  async engageKillSwitch(actorUserId: string, reason: string): Promise<EnforcementStatus> {
    return this.moveKillSwitch(actorUserId, reason, 'engaged', ENFORCEMENT_AUDIT_ACTIONS.killSwitchEngaged);
  }

  async releaseKillSwitch(actorUserId: string, reason: string): Promise<EnforcementStatus> {
    return this.moveKillSwitch(actorUserId, reason, 'released', ENFORCEMENT_AUDIT_ACTIONS.killSwitchReleased);
  }

  /**
   * The control row `FOR UPDATE`, then one UPDATE of exactly the three
   * kill-switch columns. Idempotent: a switch already in the requested state
   * writes no row and no audit row. `rollout_state`, `activation_generation`
   * and every governance row are untouched -- the trigger would refuse the
   * first two anyway, and nothing here names the third.
   */
  private async moveKillSwitch(actorUserId: string, reason: string, target: KillSwitchState, action: string): Promise<EnforcementStatus> {
    const statedReason = this.requireReason(reason);

    return this.dataSource.transaction(async (manager) => {
      const [current] = await manager.query(
        `SELECT kill_switch_state FROM commercial.booking_credit_enforcement_control WHERE id = $1 FOR UPDATE`,
        [ENFORCEMENT_CONTROL_SINGLETON_ID],
      );
      if (!current) throw new EnforcementControlMalformedError('the singleton row is missing');
      if (current.kill_switch_state === target) return this.statusWithin(manager);

      const auditId = await this.audit.record(manager, {
        actorUserId,
        action,
        targetType: AUDIT_TARGET_ENFORCEMENT,
        targetId: 'booking_credit_enforcement_control',
        reason: statedReason,
        before: { killSwitchState: current.kill_switch_state },
        after: { killSwitchState: target },
      });

      await manager.query(
        `UPDATE commercial.booking_credit_enforcement_control
            SET kill_switch_state = $2, kill_switch_changed_at = now(), kill_switch_audit_id = $3, updated_at = now()
          WHERE id = $1`,
        [ENFORCEMENT_CONTROL_SINGLETON_ID, target, auditId],
      );
      return this.statusWithin(manager);
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async statusWithin(manager: EntityManager): Promise<EnforcementStatus> {
    const row = await this.control.read(manager);
    return {
      rolloutState: row.rolloutState,
      killSwitchState: row.killSwitchState,
      activationGeneration: row.activationGeneration,
      activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
      killSwitchChangedAt: row.killSwitchChangedAt ? row.killSwitchChangedAt.toISOString() : null,
    };
  }

  private async takeCoordinationShared(manager: EntityManager): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [
      BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE,
      BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY,
    ]);
  }

  /**
   * The SAME per-party lock `consumeForConfirmation` takes, keyed the same
   * way, so a transition and a confirmation for one party are serialised on
   * one mechanism rather than two that might drift.
   */
  private async lockParty(manager: EntityManager, party: PartyRow): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      BOOKING_ENTITLEMENT_LOCK_NAMESPACE,
      `${party.party_type}:${party.party_id}`,
    ]);
  }

  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new CommercialReasonRequiredException();
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) throw new CommercialReasonRequiredException();
    return trimmed;
  }
}
