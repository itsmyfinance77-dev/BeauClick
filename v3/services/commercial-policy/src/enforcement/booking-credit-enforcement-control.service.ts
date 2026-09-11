import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import type { SubscriberPartyType } from '@beauclick/commercial-policy-contract';

import { CommercialPolicyControlGate, CommercialPolicyControlRefusal } from '../commercial-policy-control.gate';
import { lockBookingEntitlementParty } from './booking-entitlement-party-lock';
import {
  BookingCreditEnforcementControlEntity,
  BookingCreditPartyGovernanceEntity,
  ENFORCEMENT_CONTROL_SINGLETON_ID,
  ENFORCEMENT_ROLLOUT_STATES,
  KILL_SWITCH_STATES,
  PARTY_GOVERNANCE_STATES,
} from './booking-credit-enforcement.entities';

/**
 * A control row that cannot be trusted -- absent, duplicated, or holding a
 * value outside its vocabulary -- V3.3 #95 (`#58b-1`), ADR-050 §9.
 *
 * A plain `Error`, deliberately: `BeauclickExceptionFilter` reports it
 * server-side and answers the client with the generic `INTERNAL_ERROR`, and
 * throwing it inside a confirmation transaction rolls that transaction back.
 * A control plane whose state cannot be read must stop new commitments, not
 * guess -- the same posture `CaptureAmountMismatchException` takes for money.
 */
export class EnforcementControlMalformedError extends Error {
  constructor(detail: string) {
    super(`booking-credit enforcement control is malformed: ${detail}`);
    this.name = 'EnforcementControlMalformedError';
  }
}

/**
 * What the pre-ledger planes decided for one confirmation -- ADR-050 §4.
 *
 *   refuse   -- the kill switch is engaged. Nothing is consumed and the caller
 *               refuses, on both checkout paths.
 *   legacy   -- global enforcement is not active, so `#58a`'s selective path
 *               stands byte-for-byte: dormant proceeds, exhausted refuses.
 *               Governance is NOT consulted.
 *   active   -- global enforcement is active (V3.3 #141, `#58b-2`): the
 *               order's party must now be resolved through its governance
 *               row before the ledger is asked anything (`decideGovernance`).
 */
export type PreLedgerDecision =
  | Readonly<{ kind: 'refuse'; reason: Extract<CommercialPolicyControlRefusal, 'kill_switch_active'> }>
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'active' }>;

/**
 * What the business-policy plane decided for one party under an ACTIVE
 * rollout -- V3.3 #141 (`#58b-2`), ADR-050 §3.2 and §4.3.
 *
 *   refuse    -- the party is unresolved (no governance row) or its row is
 *                malformed. Activation exists to make this unreachable; if it
 *                is reached, the ledger is NOT consulted and nothing is
 *                consumed. Internal reason `business_policy_disabled`.
 *   legacy    -- an administrator recorded `legacy_exempt` with a reason: the
 *                `#58a` selective path applies exactly as before activation.
 *   governed  -- the party is inside the regime: the ledger decides, and
 *                `not_configured` is no longer a permit (`decideGovernedLedger`).
 */
export type GovernanceDecision =
  | Readonly<{ kind: 'refuse'; reason: Extract<CommercialPolicyControlRefusal, 'business_policy_disabled'> }>
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'governed' }>;

/** The `#58a` outcomes a governed party's ledger decision is made from. */
export type GovernedLedgerOutcome = 'consumed' | 'already_consumed' | 'not_configured' | 'insufficient_credit';

/**
 * The four-plane verdict for a governed party once the ledger has answered
 * -- the one call where every plane is genuinely evaluated.
 */
export type GovernedLedgerDecision =
  | Readonly<{ kind: 'permit' }>
  | Readonly<{ kind: 'refuse'; reason: Extract<CommercialPolicyControlRefusal, 'entitlement_missing'> }>;

/**
 * The persistent side of the four control planes -- V3.3 #95 (`#58b-1`),
 * ADR-050 §2.1 and §4.
 *
 * ## The row is read `FOR SHARE`, on the caller's manager, every time
 *
 * A kill-switch engagement takes the same row `FOR UPDATE`, so it commits
 * only after every confirmation that already holds the row has committed, and
 * every later confirmation waits for it. That ordering is what makes "an
 * in-flight confirmation versus an engagement" linearizable
 * (`V33-DEC-036` R8), and it needs no process-local state: nothing here is
 * cached, and a restart changes nothing because the row is the truth.
 *
 * ## `CommercialPolicyControlGate` stays the evaluator
 *
 * The gate has modelled the four planes as a pure function since Story #39.
 * This service gives it its first production caller rather than a second
 * copy of its ordering. Before the ledger is consulted, the entitlement and
 * business-policy planes are UNEVALUATED, and an unevaluated plane is passed
 * as not granted -- the gate's own fail-closed posture -- so the only
 * decisions read from it here are the two the first two planes can make:
 * `kill_switch_active` and `rollout_disabled`. `rollout_disabled` is not a
 * refusal at this seam: it is the statement that the enforcement regime is
 * not globally active, and that `#58a`'s selective path applies.
 */
@Injectable()
export class BookingCreditEnforcementControlService {
  constructor(private readonly gate: CommercialPolicyControlGate) {}

  /**
   * The control row, locked `FOR SHARE` for the rest of `manager`'s
   * transaction. Fails closed on an absent, duplicated or out-of-vocabulary
   * row.
   */
  async readForConfirmation(manager: EntityManager): Promise<BookingCreditEnforcementControlEntity> {
    const rows: BookingCreditEnforcementControlEntity[] = await manager
      .getRepository(BookingCreditEnforcementControlEntity)
      .createQueryBuilder('c')
      .setLock('pessimistic_read')
      .where('c.id = :id', { id: ENFORCEMENT_CONTROL_SINGLETON_ID })
      .getMany();
    return this.requireWellFormed(rows);
  }

  /** The control row, unlocked -- for reads that must take no lock at all (preview). */
  async read(manager: EntityManager): Promise<BookingCreditEnforcementControlEntity> {
    const rows = await manager.getRepository(BookingCreditEnforcementControlEntity).find({ where: { id: ENFORCEMENT_CONTROL_SINGLETON_ID } });
    return this.requireWellFormed(rows);
  }

  /**
   * The kill-switch and rollout planes, decided before the ledger is touched.
   *
   * The two unevaluated planes are passed as NOT granted -- the gate's own
   * fail-closed posture -- so the gate can answer only `kill_switch_active`,
   * `rollout_disabled`, or (both first planes clear) `entitlement_missing`.
   * The last is not a refusal here: it is the statement that the rollout is
   * active and the remaining planes are still to be evaluated, which is
   * `active` (V3.3 #141). A gate that PERMITS with no entitlement evaluated
   * has stopped being the gate this service was written against.
   */
  decideBeforeLedger(control: BookingCreditEnforcementControlEntity): PreLedgerDecision {
    const decision = this.gate.decide({
      killSwitchActive: control.killSwitchState === 'engaged',
      rolloutEnabled: control.rolloutState === 'active',
      entitlementGranted: false,
      businessPolicyEnabled: false,
    });

    if (decision.allowed) {
      throw new EnforcementControlMalformedError('the control gate permitted a confirmation with no entitlement evaluated');
    }
    switch (decision.reason) {
      case 'kill_switch_active':
        return { kind: 'refuse', reason: 'kill_switch_active' };
      case 'rollout_disabled':
        return { kind: 'legacy' };
      case 'entitlement_missing':
        return { kind: 'active' };
      default:
        throw new EnforcementControlMalformedError(`the control gate answered '${decision.reason}' before any plane beyond rollout was evaluated`);
    }
  }

  /**
   * The party's governance row, read UNDER the `bcre` party lock on the
   * caller's manager -- V3.3 #141, ADR-050 §4.1 ("after the party lock").
   *
   * The lock is the same transaction-scoped advisory lock
   * `consumeForConfirmation` and the transition command take, keyed the same
   * way; the ledger's own acquisition a moment later is re-entrant. Holding
   * it here means a transition of THIS party (which locks `bcre` before it
   * writes) either committed before this read or waits until this
   * confirmation commits -- never lands between the read and the ledger.
   */
  async readGovernanceForConfirmation(
    manager: EntityManager,
    party: { readonly partyType: SubscriberPartyType; readonly partyId: string },
  ): Promise<BookingCreditPartyGovernanceEntity | null> {
    await lockBookingEntitlementParty(manager, party);
    return manager.getRepository(BookingCreditPartyGovernanceEntity).findOne({
      where: { partyType: party.partyType, partyId: party.partyId },
    });
  }

  /**
   * The business-policy plane for one party under an ACTIVE rollout --
   * ADR-050 §4.3, rows 4-8.
   *
   * Decided HERE and not through `CommercialPolicyControlGate.decide`: the
   * gate evaluates entitlement before business policy, so with the ledger
   * honestly unevaluated it can only ever answer `entitlement_missing`. An
   * unresolved party is refused for the reason that is true of it -- nobody
   * decided its policy -- and the ledger is never asked, so nothing is
   * consumed. The gate's ordering is not changed to force the vocabulary.
   */
  decideGovernance(control: BookingCreditEnforcementControlEntity, governance: BookingCreditPartyGovernanceEntity | null): GovernanceDecision {
    if (control.rolloutState !== 'active') {
      throw new EnforcementControlMalformedError('governance was consulted while the rollout is not active');
    }
    if (!governance) return { kind: 'refuse', reason: 'business_policy_disabled' };
    if (!(PARTY_GOVERNANCE_STATES as readonly string[]).includes(governance.state)) {
      return { kind: 'refuse', reason: 'business_policy_disabled' };
    }
    return governance.state === 'governed' ? { kind: 'governed' } : { kind: 'legacy' };
  }

  /**
   * The full four-plane verdict for a GOVERNED party, once `#58a`'s ledger
   * has answered -- ADR-050 §4.3 rows 4-5. This is the one place every input
   * to the gate is genuinely evaluated: the switch is released and the
   * rollout active (or we would not be here), the party's policy is enabled
   * (it is governed), and entitlement is exactly what the ledger said.
   * `not_configured` is NOT a permit for a governed party (`V33-DEC-036` R2:
   * zero never means unlimited), and neither is exhaustion.
   */
  decideGovernedLedger(ledger: GovernedLedgerOutcome): GovernedLedgerDecision {
    const decision = this.gate.decide({
      killSwitchActive: false,
      rolloutEnabled: true,
      entitlementGranted: ledger === 'consumed' || ledger === 'already_consumed',
      businessPolicyEnabled: true,
    });
    if (decision.allowed) return { kind: 'permit' };
    if (decision.reason === 'entitlement_missing') return { kind: 'refuse', reason: 'entitlement_missing' };
    throw new EnforcementControlMalformedError(`the control gate answered '${decision.reason}' for a governed party under an active rollout`);
  }

  private requireWellFormed(rows: BookingCreditEnforcementControlEntity[]): BookingCreditEnforcementControlEntity {
    if (rows.length !== 1) throw new EnforcementControlMalformedError(`expected exactly one control row, found ${rows.length}`);
    const [row] = rows;
    if (!(ENFORCEMENT_ROLLOUT_STATES as readonly string[]).includes(row.rolloutState)) {
      throw new EnforcementControlMalformedError(`rollout_state '${row.rolloutState}' is outside the vocabulary`);
    }
    if (!(KILL_SWITCH_STATES as readonly string[]).includes(row.killSwitchState)) {
      throw new EnforcementControlMalformedError(`kill_switch_state '${row.killSwitchState}' is outside the vocabulary`);
    }
    return row;
  }
}
