/**
 * The commission policy contract and its arithmetic — V3.3 Story #173
 * (`#43b-1`), ADR-052 §1 and §3, `V33-DEC-040` R1 and R3, ratified by
 * `V33-DEC-044`.
 *
 * Browser-safe and implementation-free in the same sense as the outcome
 * contracts beside it: `commercial` publishes rules, `#43b-2` (#192) snapshots
 * them onto orders and `#43c` recognises money from them, and none of the
 * three may import another's implementation. This file is the vocabulary all
 * three share, plus the one piece of arithmetic that must produce the same
 * number wherever it runs.
 *
 * ## It carries no value
 *
 * No rate, no fixed amount, no base and no component default appears below.
 * Every constant here is a BOUNDARY (the basis-point ceiling, the
 * representational amount ceiling) or a closed VOCABULARY, never a commercial
 * choice. `commercial.commission_policy_versions` repeats each vocabulary as a
 * SQL CHECK, so a member added here and not there is refused by the database
 * rather than silently written.
 *
 * ## Arithmetic
 *
 * Integer toman as `BigInt` throughout, for the reason the outcome evaluator
 * records: `base_value × bp` reaches 10¹⁷ at the representational ceiling,
 * past `Number`'s exact integer range, so no step may be a `Number`. Division
 * floors — `BigInt` division truncates toward zero and both operands are
 * non-negative, which are the same thing here — and ADR-052 §3 specifies
 * `floor` explicitly so the platform never rounds a fraction of a toman in its
 * own favour.
 */

/** The representational ceiling every amount in this family shares with the outcome family. */
export const MAX_COMMISSION_AMOUNT_TOMAN = 10_000_000_000_000;

/** 100% in basis points. A boundary, not a rate. */
export const MAX_COMMISSION_BASIS_POINTS = 10_000;

/**
 * Which arithmetic produced an amount. `#43b-2` copies this onto every order's
 * snapshot so that a rule evaluated later is evaluated the way it was
 * understood when the order committed, even if this engine is corrected
 * afterwards. Raise it — never redefine the behaviour of an existing value —
 * when a correction would change a number this version already produced.
 */
export const COMMISSION_ARITHMETIC_VERSION = 1;

/**
 * ADR-052 §3's fixed evaluation order. Exported as a tuple because the ORDER
 * is itself binding: the held ceiling is allocated across components in this
 * sequence, so two callers iterating differently would deduct different
 * amounts from the same facts.
 */
export const COMMISSION_COMPONENTS = ['booking_commission', 'acquisition', 'processing_recovery'] as const;
export type CommissionComponent = (typeof COMMISSION_COMPONENTS)[number];

/** The four closed shapes (ADR-052 §1). `zero` is a published decision, not the absence of one. */
export const COMMISSION_RULE_KINDS = ['zero', 'percentage', 'fixed', 'hybrid'] as const;
export type CommissionRuleKind = (typeof COMMISSION_RULE_KINDS)[number];

/**
 * What a percentage is taken OF (ADR-052 §3):
 *  - `platform_collected_amount` → `commerce.orders.collected_total_toman`
 *  - `service_total`             → `commerce.orders.total_toman`
 *
 * The two differ by exactly what the customer has not paid yet, which is why
 * the column carrying this has no database DEFAULT and this type has no
 * fallback member.
 */
export const COMMISSION_BASES = ['platform_collected_amount', 'service_total'] as const;
export type CommissionBase = (typeof COMMISSION_BASES)[number];

/**
 * What binds one order and one component (ADR-052 §2). `absent` means nobody
 * has published a rule; `zero` means somebody published "nothing is charged".
 * `#43c` must be able to tell those apart when it explains why an order was
 * never charged, so they are two members rather than one.
 */
export const COMMISSION_TERM_STATES = ['absent', 'zero', 'rule'] as const;
export type CommissionTermState = (typeof COMMISSION_TERM_STATES)[number];

/**
 * One resolved rule, as a snapshot carries it. Every field is a VALUE copied at
 * commitment; nothing here is a reference the reader must dereference later,
 * because `V33-DEC-028` Ruling 4 forbids re-reading live policy at recognition.
 */
export interface CommissionTermV1 {
  readonly component: CommissionComponent;
  readonly state: CommissionTermState;
  /**
   * WHICH published version bound the order (`#43b-2`, ADR-052 §2). Present
   * exactly for `zero` and `rule`: a published `zero` is a decision and must
   * be traceable to the version that made it, while an `absent` names nothing
   * because nothing was published.
   */
  readonly policyKey: string | null;
  readonly policyVersion: number | null;
  /** Absent exactly when `state === 'absent'`. */
  readonly ruleKind: CommissionRuleKind | null;
  readonly basisPoints: number | null;
  readonly fixedToman: number | null;
  readonly base: CommissionBase | null;
  /** Null exactly when `state === 'absent'`: no version bound the order, so no arithmetic did either. */
  readonly arithmeticVersion: number | null;
}

/** Why a recognition produced the amount it did. Closed, and recorded by `#43c`. */
export const COMMISSION_OUTCOME_BASES = ['completion', 'seller_retained'] as const;
export type CommissionOutcomeBasis = (typeof COMMISSION_OUTCOME_BASES)[number];

export interface CommissionEvaluationInputV1 {
  /**
   * Which outcome is being recognised.
   *  - `completion`: ADR-052 §3's completion rule. Each component reads its own
   *    `base`, the deduction is capped at what is still held, and anything above
   *    that cap becomes a receivable.
   *  - `seller_retained`: the `OC-2` rule `V33-DEC-044` decided. EVERY component,
   *    whatever its own `base` says, is computed on the retained amount, the
   *    total is capped at the retained amount, and NO receivable is ever created.
   */
  readonly basis: CommissionOutcomeBasis;
  /** The order's terms. One entry per component; a missing component is treated as `absent`. */
  readonly terms: readonly CommissionTermV1[];
  /** `commerce.orders.collected_total_toman` at recognition. Ignored when `basis === 'seller_retained'`. */
  readonly collectedTotalToman: number;
  /** `commerce.orders.total_toman`. Ignored when `basis === 'seller_retained'`. */
  readonly serviceTotalToman: number;
  /** Seller-attributable money still recorded for the order. The completion ceiling. */
  readonly heldToman: number;
  /** The outcome decision's `retained_toman`. Required for `seller_retained`, ignored otherwise. */
  readonly retainedToman: number;
}

export interface CommissionComponentResultV1 {
  readonly component: CommissionComponent;
  readonly state: CommissionTermState;
  /** What the rule asks for, before any ceiling. */
  readonly computedToman: number;
  /** What is actually deducted, after the ceiling is allocated in component order. */
  readonly deductibleToman: number;
}

export interface CommissionEvaluationV1 {
  readonly basis: CommissionOutcomeBasis;
  readonly components: readonly CommissionComponentResultV1[];
  /** `k` — the sum of what every component's rule asks for. */
  readonly computedTotalToman: number;
  /** `min(k, ceiling)`, the sum of the per-component deductions. */
  readonly deductibleTotalToman: number;
  /**
   * `k − deductible`, and ALWAYS ZERO for `seller_retained`: ADR-052 §3 is
   * explicit that a cancellation or no-show never creates a receivable, so the
   * uncharged remainder is simply not charged.
   */
  readonly excessToman: number;
  /** True only when `excessToman > 0`, i.e. never for `seller_retained`. */
  readonly createsReceivable: boolean;
}

const ZERO = 0n;

function requireInteger(label: string, value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer number of toman, received ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, received ${value}`);
  }
  if (value > MAX_COMMISSION_AMOUNT_TOMAN) {
    throw new RangeError(`${label} exceeds MAX_COMMISSION_AMOUNT_TOMAN, received ${value}`);
  }
  return BigInt(value);
}

/**
 * One component's rule, applied to one base value. The four shapes of ADR-052
 * §3, and nothing else: a term this function cannot read is a defect in the
 * caller or in the CHECK matrix, never a reason to guess a number.
 */
function computeComponent(term: CommissionTermV1, baseValue: bigint): bigint {
  if (term.state === 'absent' || term.state === 'zero' || term.ruleKind === null || term.ruleKind === 'zero') {
    return ZERO;
  }

  const bp = term.basisPoints === null ? null : requireInteger(`${term.component}.basisPoints`, term.basisPoints);
  const fixed = term.fixedToman === null ? null : requireInteger(`${term.component}.fixedToman`, term.fixedToman);

  if (bp !== null && bp > BigInt(MAX_COMMISSION_BASIS_POINTS)) {
    throw new RangeError(`${term.component}.basisPoints exceeds ${MAX_COMMISSION_BASIS_POINTS}`);
  }

  switch (term.ruleKind) {
    case 'percentage':
      if (bp === null) throw new RangeError(`${term.component}: a percentage rule requires basisPoints`);
      return (baseValue * bp) / BigInt(MAX_COMMISSION_BASIS_POINTS);
    case 'fixed':
      if (fixed === null) throw new RangeError(`${term.component}: a fixed rule requires fixedToman`);
      return fixed;
    case 'hybrid':
      if (bp === null || fixed === null) {
        throw new RangeError(`${term.component}: a hybrid rule requires both basisPoints and fixedToman`);
      }
      return fixed + (baseValue * bp) / BigInt(MAX_COMMISSION_BASIS_POINTS);
    default:
      throw new RangeError(`${term.component}: unknown rule kind`);
  }
}

/**
 * THE commission engine (ADR-052 §3).
 *
 * Pure: no clock, no I/O, no configuration, no default. Every input is a value
 * the caller read inside the recognising transaction — or copied from the
 * order's own snapshot — so the same facts always produce the same amount, and
 * a replay can never charge differently from the original.
 *
 * ## The two outcomes, and why they do not share a base
 *
 * On **completion**, each component is computed on the base its published rule
 * names, the total is capped at what is still held, and the uncharged
 * remainder becomes a receivable with cause `commission_excess` — R1's own
 * mechanism, never revenue before recovery.
 *
 * On a **seller-retained** cancellation or no-show, `V33-DEC-044` decided OC-2:
 * R3 gives BeauClick its published share *on the retained amount*, so every
 * component is computed on `retainedToman` whatever its own `base` says, the
 * total is capped at `retainedToman`, and no receivable is ever created. The
 * ADR's own example: collected 100, refunded 60, retained 40, 10% ⇒ 4; the same
 * facts with a `fixed 50` rule ⇒ 40 deducted and nothing owed afterwards.
 *
 * ## The ceiling is allocated in component order
 *
 * `deductible = min(k, ceiling)` is a total, but money is deducted per
 * component, so the ceiling is consumed in the fixed order
 * `booking_commission, acquisition, processing_recovery`. A later component
 * receives only what earlier ones left. The order is not a preference: it is
 * what makes the split reproducible.
 */
export function evaluateCommission(input: CommissionEvaluationInputV1): CommissionEvaluationV1 {
  const collected = requireInteger('collectedTotalToman', input.collectedTotalToman);
  const serviceTotal = requireInteger('serviceTotalToman', input.serviceTotalToman);
  const held = requireInteger('heldToman', input.heldToman);
  const retained = requireInteger('retainedToman', input.retainedToman);

  const retainedBasis = input.basis === 'seller_retained';
  const ceiling = retainedBasis ? retained : held;

  const byComponent = new Map<CommissionComponent, CommissionTermV1>();
  for (const term of input.terms) {
    byComponent.set(term.component, term);
  }

  const computed: Array<{ term: CommissionTermV1; component: CommissionComponent; amount: bigint }> = [];
  let total = ZERO;

  for (const component of COMMISSION_COMPONENTS) {
    const term: CommissionTermV1 = byComponent.get(component) ?? {
      component,
      state: 'absent',
      policyKey: null,
      policyVersion: null,
      ruleKind: null,
      basisPoints: null,
      fixedToman: null,
      base: null,
      arithmeticVersion: null,
    };

    // The retained outcome overrides the rule's own base — deliberately, and
    // this is the single place that override lives.
    const baseValue = retainedBasis ? retained : term.base === 'service_total' ? serviceTotal : collected;

    const amount = computeComponent(term, baseValue);
    computed.push({ term, component, amount });
    total += amount;
  }

  let remaining = ceiling;
  const components: CommissionComponentResultV1[] = computed.map(({ term, component, amount }) => {
    const deductible = amount < remaining ? amount : remaining;
    remaining -= deductible;
    return {
      component,
      state: term.state,
      computedToman: Number(amount),
      deductibleToman: Number(deductible),
    };
  });

  const deductibleTotal = ceiling < total ? ceiling : total;
  // Never for `seller_retained`: ADR-052 §3 is explicit that a cancellation or
  // no-show creates no receivable, so the remainder above the cap is simply
  // not charged rather than owed.
  const excess = retainedBasis ? ZERO : total - deductibleTotal;

  return {
    basis: input.basis,
    components,
    computedTotalToman: Number(total),
    deductibleTotalToman: Number(deductibleTotal),
    excessToman: Number(excess),
    createsReceivable: excess > ZERO,
  };
}

/**
 * The LEGACY reversal (ADR-052 §3, §16).
 *
 * An order whose collection is a `financial.ledger_entries` row stays on that
 * ledger for life and reverses there at its ORIGINAL rate. The amount is
 * cumulative, not incremental: the commission share of the net amount that
 * remains after all refunds so far, minus everything already reversed. Stated
 * that way, no residue survives a full refund and no existing row changes —
 * an incremental formula drifts by a toman per refund through repeated
 * flooring, and the drift is permanent because the rows are append-only.
 *
 * Returns the amount to reverse NOW, never negative: a refund that would imply
 * a negative reversal means more has already been reversed than is owed, which
 * is a reconciliation exception for `#43c`, not a payment back to the platform.
 */
export function legacyCommissionReversalToman(input: {
  readonly originalNetToman: number;
  readonly refundedToDateToman: number;
  readonly originalRateBp: number;
  readonly alreadyReversedToman: number;
}): number {
  const net = requireInteger('originalNetToman', input.originalNetToman);
  const refunded = requireInteger('refundedToDateToman', input.refundedToDateToman);
  const reversed = requireInteger('alreadyReversedToman', input.alreadyReversedToman);
  const rate = requireInteger('originalRateBp', input.originalRateBp);

  if (rate > BigInt(MAX_COMMISSION_BASIS_POINTS)) {
    throw new RangeError(`originalRateBp exceeds ${MAX_COMMISSION_BASIS_POINTS}`);
  }
  if (refunded > net) {
    throw new RangeError('refundedToDateToman cannot exceed originalNetToman');
  }

  const remainingNet = net - refunded;
  const commissionOnRemaining = (remainingNet * rate) / BigInt(MAX_COMMISSION_BASIS_POINTS);
  const commissionOriginal = (net * rate) / BigInt(MAX_COMMISSION_BASIS_POINTS);
  const owedReversal = commissionOriginal - commissionOnRemaining;
  const now = owedReversal - reversed;
  return Number(now > ZERO ? now : ZERO);
}
