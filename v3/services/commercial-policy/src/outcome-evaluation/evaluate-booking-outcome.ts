import {
  BookingOutcomeEvaluationInputV1,
  BookingOutcomeEvaluationV1,
  BookingOutcomeRetentionRule,
  MAX_OUTCOME_AMOUNT_TOMAN,
} from '@beauclick/commercial-policy-contract';

/**
 * THE booking outcome evaluator — V3.3 Story #160 (`#42c`), ADR-051 §6,
 * `V33-DEC-039` R1, R2, R4, R5. Extended by #161 (`#42d`), ADR-051 §7, for
 * `cause === 'no_show'`.
 *
 * Pure: no clock, no I/O, no configuration, no default. Every input is a fact
 * the caller read inside the deciding transaction — the timeliness comparison
 * itself was done in SQL — so the same facts always produce the same decision,
 * and a replay can never decide differently from the original.
 *
 * ## The order of the rules is the ratified order
 *
 *  1. no terms row                  → `legacy_unenrolled`, retain 0 (today's full refund)
 *  2. terms the contract rejects    → `invalid_terms`, retain 0 (defence in depth)
 *  3. `cause === 'no_show'`         → §7's own branch (below), never R7's non-customer rule
 *  4. cause is not the customer     → `non_customer_cause`, retain 0 (R7)
 *  5. the booking was never confirmed → `not_confirmed`, retain 0 (R1: only after a valid event)
 *  6. timely (the boundary included) → `timely`, retain 0 (R2, R4)
 *  7. Legal cap absent / retired    → `cap_absent` / `cap_retired`, retain 0 (R5, ADR-051 §5)
 *  8. otherwise                     → `cap_applied`, retain `min(policy, cap, collectedRemaining)`
 *
 * A no-show reads `terms.noShowRetention` instead of `terms.lateCancellationRetention`
 * and carries no cutoff/timeliness concept at all (`timely` and `cutoffInstant`
 * are always `null` for this decision kind, ADR-051 §7): the window that gates
 * evaluation is the declaration's objection window, not a cutoff, and a
 * no-show is reachable only from `confirmed` (R6), so `bookingWasConfirmed` is
 * checked for defence in depth rather than because it can genuinely be false.
 *
 * An absent cap is never "capped at the policy amount": it short-circuits to
 * zero, which is the one reading that cannot activate retention without
 * recorded Legal evidence.
 *
 * ## Arithmetic
 *
 * Integer toman as `BigInt` throughout. `collectedRemaining × basisPoints`
 * reaches 10¹⁷ at the representational ceiling, past `Number`'s exact range, so
 * no step is a `Number`. Percentages floor (`BigInt` division truncates, and
 * both operands are non-negative).
 */
export function evaluateBookingOutcome(input: BookingOutcomeEvaluationInputV1): BookingOutcomeEvaluationV1 {
  const collected = input.collectedRemainingToman;
  if (collected < 0n) {
    throw new Error('evaluateBookingOutcome: collectedRemainingToman must not be negative');
  }

  const zero = (
    basis: BookingOutcomeEvaluationV1['basis'],
    policyAmountToman: bigint,
    legalCapToman: bigint | null,
    legalCapState: BookingOutcomeEvaluationV1['legalCapState'],
  ): BookingOutcomeEvaluationV1 => ({
    basis,
    policyAmountToman,
    legalCapToman,
    legalCapState,
    retainedToman: 0n,
    refundToman: collected,
  });

  if (input.terms === null) {
    return zero('legacy_unenrolled', 0n, null, 'absent');
  }

  const isNoShow = input.cause === 'no_show';
  const retentionRule = isNoShow ? input.terms.noShowRetention : input.terms.lateCancellationRetention;
  const policyAmount = retentionAmount(retentionRule, collected);
  if (policyAmount === null || (!isNoShow && input.timely === null)) {
    return zero('invalid_terms', 0n, null, 'absent');
  }

  let capState = input.legalCapState;
  let capAmount: bigint | null = null;
  if (capState === 'applied') {
    capAmount = input.terms.legalCap === null ? null : retentionAmount(input.terms.legalCap, collected);
    // A cap "applied" with no valid cap rule is not a cap. Absent, never guessed.
    if (capAmount === null) capState = 'absent';
  }

  if (!isNoShow && input.cause !== 'customer') return zero('non_customer_cause', policyAmount, capAmount, capState);
  if (!input.bookingWasConfirmed) return zero('not_confirmed', policyAmount, capAmount, capState);
  if (!isNoShow && input.timely) return zero('timely', policyAmount, capAmount, capState);
  if (capState === 'retired') return zero('cap_retired', policyAmount, null, 'retired');
  if (capState === 'absent' || capAmount === null) return zero('cap_absent', policyAmount, null, 'absent');

  const retained = min(policyAmount, capAmount, collected);
  return {
    basis: 'cap_applied',
    policyAmountToman: policyAmount,
    legalCapToman: capAmount,
    legalCapState: 'applied',
    retainedToman: retained,
    refundToman: collected - retained,
  };
}

/**
 * One closed rule shape applied to the remaining collected amount, or `null`
 * when the rule is not one the contract admits. `null` is refused by the
 * caller as `invalid_terms` — never read as zero, never read as a value.
 */
export function retentionAmount(rule: BookingOutcomeRetentionRule, collectedRemaining: bigint): bigint | null {
  switch (rule.kind) {
    case 'none':
      return 0n;
    case 'full_collected':
      return collectedRemaining;
    case 'percentage_of_collected': {
      const bp = rule.basisPoints;
      if (!Number.isInteger(bp) || bp < 1 || bp > 9_999) return null;
      return (collectedRemaining * BigInt(bp)) / 10_000n;
    }
    case 'fixed_toman': {
      const amount = rule.amountToman;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_OUTCOME_AMOUNT_TOMAN) return null;
      return BigInt(amount);
    }
    default:
      return null;
  }
}

function min(a: bigint, b: bigint, c: bigint): bigint {
  let m = a < b ? a : b;
  if (c < m) m = c;
  return m;
}
