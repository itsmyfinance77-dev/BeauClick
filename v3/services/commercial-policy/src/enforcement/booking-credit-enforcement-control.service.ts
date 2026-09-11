import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { CommercialPolicyControlGate, CommercialPolicyControlRefusal } from '../commercial-policy-control.gate';
import {
  BookingCreditEnforcementControlEntity,
  ENFORCEMENT_CONTROL_SINGLETON_ID,
  ENFORCEMENT_ROLLOUT_STATES,
  KILL_SWITCH_STATES,
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
 *
 * There is deliberately NO third member for an active rollout. #95 ships no
 * code that writes `rollout_state = 'active'`, and the fail-closed outcomes of
 * a governed or unresolved party under active enforcement belong to #141
 * (`#58b-2`). Until that story lands, an active row is a state this release
 * does not know how to honour and refuses loudly (see `decideBeforeLedger`).
 */
export type PreLedgerDecision =
  | Readonly<{ kind: 'refuse'; reason: Extract<CommercialPolicyControlRefusal, 'kill_switch_active'> }>
  | Readonly<{ kind: 'legacy' }>;

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
   * With `rollout_state = 'active'` this release has nothing correct to do:
   * the governed and unresolved outcomes are #141's, and honouring the legacy
   * path under an active rollout would be exactly the silent fallback
   * `V33-DEC-036` R8 forbids. The row cannot reach that state through any #95
   * code, so reaching it here means the database was moved by hand ahead of
   * the code that understands it -- a malformed state, refused loudly.
   */
  decideBeforeLedger(control: BookingCreditEnforcementControlEntity): PreLedgerDecision {
    const decision = this.gate.decide({
      killSwitchActive: control.killSwitchState === 'engaged',
      rolloutEnabled: control.rolloutState === 'active',
      entitlementGranted: false,
      businessPolicyEnabled: false,
    });

    if (decision.allowed) {
      // Unreachable while both unevaluated planes are passed as not granted;
      // kept as a refusal because "unreachable" is a claim about the gate.
      throw new EnforcementControlMalformedError('the control gate permitted a confirmation with no entitlement evaluated');
    }
    switch (decision.reason) {
      case 'kill_switch_active':
        return { kind: 'refuse', reason: 'kill_switch_active' };
      case 'rollout_disabled':
        return { kind: 'legacy' };
      default:
        throw new EnforcementControlMalformedError(
          `rollout_state is '${control.rolloutState}' but this release implements no active-rollout confirmation outcome (#141)`,
        );
    }
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
