/**
 * The booking-outcome snapshot, the seller's selection and the customer's
 * acceptance — V3.3 Story #159 (`#42b`), ADR-051 §2–§4.
 *
 * Browser-safe and dependency-free like the rest of this package. It builds on
 * `#42a`'s publication vocabulary (`booking-outcome-policy-contract.ts`) and
 * adds what a seller selects inside it, what an order snapshots from it, and
 * the one object a customer echoes to accept it.
 *
 * ## Why these are new types rather than `BookingCommercialTermsV1`
 *
 * ADR-051 §2 supersedes the pre-ratification v1 contract for outcome terms and
 * forbids reusing, widening or re-versioning it. That file is untouched; these
 * types carry their own validators under `BOOKING_OUTCOME_CONTRACT_VERSION`.
 *
 * ## Absent, never zero-filled
 *
 * An order with no outcome terms has NO snapshot — not a snapshot of zeros.
 * `#42c` fails closed on the absence (`V33-DEC-029` Ruling 3), so nothing here
 * has a default and every validator refuses a missing member.
 */

import {
  BOOKING_OUTCOME_CONTRACT_VERSION,
  BookingOutcomeRetentionRule,
  CUSTOMER_POLICY_COPY_LOCALES,
  CustomerPolicyCopyLocale,
  MAX_OUTCOME_GRACE_MINUTES,
  MAX_OUTCOME_HOURS,
  MAX_OUTCOME_RESCHEDULE_FREE_COUNT,
  MAX_OUTCOME_RETENTION_DAYS,
  retentionRuleIdentity,
  validateBookingOutcomeRetentionRule,
} from './booking-outcome-policy-contract';

/** The key shape every commercial family shares. */
export const BOOKING_OUTCOME_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * What a seller chooses: exactly one member of each of the four published
 * sets (`V33-DEC-039` R4–R6, ADR-051 §3). Copied by value into the assignment
 * and again into the order snapshot, so no later reader re-reads the family.
 */
export interface BookingOutcomeSelectionV1 {
  readonly cutoffHours: number;
  readonly lateCancellationRetention: BookingOutcomeRetentionRule;
  readonly noShowGraceMinutes: number;
  readonly noShowRetention: BookingOutcomeRetentionRule;
}

/** The members a published version allows a seller to choose from. */
export interface AllowedOutcomeMembersV1 {
  readonly cutoffHours: readonly number[];
  readonly lateCancellationRetention: readonly BookingOutcomeRetentionRule[];
  readonly noShowGraceMinutes: readonly number[];
  readonly noShowRetention: readonly BookingOutcomeRetentionRule[];
}

/**
 * The terms an order records — the seller's four selections plus the
 * administrator values of the version active at commitment, all by value.
 *
 * `legalCap` is the version's cap rule when one was published against recorded
 * evidence (ADR-051 §5); `null` means absent, which `#42c` reads as zero
 * retention. The evidence reference is NOT a term: it lives on the snapshot,
 * because terms reach customer-facing reads and the evidence never does.
 */
export interface BookingOutcomeTermsV1 extends BookingOutcomeSelectionV1 {
  readonly contractVersion: typeof BOOKING_OUTCOME_CONTRACT_VERSION;
  readonly rescheduleFreeCountBeforeCutoff: number;
  readonly disputeWindowHours: number;
  readonly bodilyHarmWindowHours: number | null;
  readonly appealWindowHours: number;
  readonly caseFileRetentionDays: number | null;
  readonly legalCap: BookingOutcomeRetentionRule | null;
}

/**
 * What one order snapshots (ADR-051 §3): which numeric version and which copy
 * version, when the database resolved them, and the terms by value.
 *
 * `legalEvidenceId` is the evidence record the version's cap referenced, kept
 * so `#42c` can re-check its status at decision time. It is present exactly
 * when `terms.legalCap` is, and it is never projected to a customer or seller.
 */
export interface BookingOutcomeSnapshotV1 {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly copyKey: string;
  readonly copyVersion: number;
  /** The database instant the versions were resolved at; ISO-8601 UTC. */
  readonly resolvedAt: string;
  readonly legalEvidenceId: string | null;
  readonly terms: BookingOutcomeTermsV1;
}

/**
 * The customer's explicit acceptance: exactly what the disclosure showed,
 * echoed back on the checkout command (ADR-051 §4). Four identifiers, no
 * instant (the database supplies it), no text, no device, no network fact.
 */
export interface BookingOutcomeAcceptanceV1 {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly copyKey: string;
  readonly copyVersion: number;
}

/**
 * Why an enrolled seller's outcome terms could not be resolved. Closed,
 * bounded and identity-free, so it is safe as a metric label; it never reaches
 * a response body — every cause is the same public refusal.
 */
export const BOOKING_OUTCOME_UNAVAILABLE_CAUSES = [
  /** The assigned key has no version published and active at the database instant. */
  'no_active_version',
  /** More than one active version for one key — unreachable while the exclusion constraint holds. */
  'ambiguous_version',
  /** A selected member is not in the active version (the family was re-ranged forward). */
  'member_not_allowed',
  /** No published customer-policy copy version is active at the database instant. */
  'no_active_copy',
  /** More than one copy version is active platform-wide; the platform never picks one. */
  'ambiguous_copy',
  /** The resolved rows do not satisfy this contract. */
  'invalid_snapshot',
] as const;
export type BookingOutcomeUnavailableCause = (typeof BOOKING_OUTCOME_UNAVAILABLE_CAUSES)[number];

// ---------------------------------------------------------------------------
// The seller surface (projections; the omissions are the contract)
// ---------------------------------------------------------------------------

export const OUTCOME_POLICY_ASSIGNMENT_REASON_MIN_LENGTH = 3;
export const OUTCOME_POLICY_ASSIGNMENT_REASON_MAX_LENGTH = 500;

/** One assignable key: its display name and the members a seller may choose. Nothing administrative. */
export interface AssignableOutcomePolicyV1 {
  readonly policyKey: string;
  readonly displayName: string;
  readonly allowed: AllowedOutcomeMembersV1;
}

export interface AssignableOutcomePolicyListV1 {
  readonly items: readonly AssignableOutcomePolicyV1[];
}

/**
 * The seller's current selection. `resolvable` says whether it still fits the
 * version active right now — when it is false, new governed bookings fail
 * closed until the seller selects again (ADR-051 §3).
 */
export interface CurrentOutcomePolicyAssignmentV1 {
  readonly policyKey: string;
  readonly displayName: string;
  readonly selection: BookingOutcomeSelectionV1;
  readonly assignedAt: string;
  readonly resolvable: boolean;
}

/** `assignment: null` is the unenrolled state, which is legitimate. */
export interface OutcomePolicyAssignmentViewV1 {
  readonly assignment: CurrentOutcomePolicyAssignmentV1 | null;
}

/** The one public refusal code for the seller surface, lower-case like its #104 twin. */
export const OUTCOME_POLICY_ASSIGNMENT_UNAVAILABLE = 'outcome_policy_assignment_unavailable' as const;

export const OUTCOME_POLICY_ASSIGNMENT_REFUSAL_CAUSES = [
  'workspace_unresolvable',
  'policy_unavailable',
  'selection_not_allowed',
  'assignment_conflict',
] as const;
export type OutcomePolicyAssignmentRefusalCause = (typeof OUTCOME_POLICY_ASSIGNMENT_REFUSAL_CAUSES)[number];

// ---------------------------------------------------------------------------
// The disclosure read (V33-DEC-039 R13, V33-DEC-042 R2)
// ---------------------------------------------------------------------------

/** Display zone for every instant a customer sees (`V33-DEC-039` R4). Arithmetic never depends on it. */
export const BOOKING_OUTCOME_DISPLAY_TIME_ZONE = 'Asia/Tehran' as const;

export interface BookingOutcomeDisclosedCopyV1 {
  readonly locale: CustomerPolicyCopyLocale;
  readonly body: string;
  readonly bodySha256: string;
  readonly publishedAt: string;
}

/** The resolved outcome as a customer sees it. No evidence reference, no cap internals, no actor. */
export interface BookingOutcomeDisclosedTermsV1 {
  readonly cutoffHours: number;
  /** `slotStart − cutoffHours`, ISO-8601 UTC; the customer's screen renders it in the display zone. */
  readonly cutoffInstant: string;
  readonly lateCancellationRetention: BookingOutcomeRetentionRule;
  readonly noShowGraceMinutes: number;
  readonly noShowRetention: BookingOutcomeRetentionRule;
  readonly rescheduleFreeCountBeforeCutoff: number;
  readonly disputeWindowHours: number;
  readonly bodilyHarmWindowHours: number | null;
  readonly appealWindowHours: number;
  readonly copy: BookingOutcomeDisclosedCopyV1;
}

/**
 * Everything the customer is shown before confirming, from the server.
 *
 * `acceptance` is the exact object to echo as `acceptedPolicy` on the checkout
 * when `acceptanceRequired` is true. When it is false the seller is
 * unenrolled — or enrolled but unconfigured on a booking that collects nothing
 * online (`V33-DEC-039` R13) — and the checkout must carry no acceptance.
 */
export interface BookingOutcomeDisclosureV1 {
  readonly sellerParty: { readonly kind: 'professional' | 'business'; readonly displayName: string };
  readonly amounts: {
    readonly serviceTotalToman: number;
    readonly platformCollectibleNowToman: number;
    readonly venueBalanceToman: number;
  };
  readonly slotStartsAt: string;
  readonly displayTimeZone: typeof BOOKING_OUTCOME_DISPLAY_TIME_ZONE;
  readonly acceptanceRequired: boolean;
  readonly outcome: BookingOutcomeDisclosedTermsV1 | null;
  readonly acceptance: BookingOutcomeAcceptanceV1 | null;
}

// ---------------------------------------------------------------------------
// Validators. Shape only; the database is the authoritative layer.
// ---------------------------------------------------------------------------

function isWholeInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function exactKeys(value: object, allowed: readonly string[], label: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} carries an unknown field ${key}`);
  }
}

const SELECTION_KEYS = ['cutoffHours', 'lateCancellationRetention', 'noShowGraceMinutes', 'noShowRetention'] as const;

export function validateBookingOutcomeSelectionV1(selection: unknown): readonly string[] {
  const errors: string[] = [];
  const candidate = selection as Partial<BookingOutcomeSelectionV1> | null;
  if (!candidate || typeof candidate !== 'object') return ['selection must be an object'];
  exactKeys(candidate, SELECTION_KEYS, 'selection', errors);
  if (!isWholeInRange(candidate.cutoffHours, 0, MAX_OUTCOME_HOURS)) {
    errors.push(`cutoffHours must be an integer between 0 and ${MAX_OUTCOME_HOURS}`);
  }
  if (!isWholeInRange(candidate.noShowGraceMinutes, 0, MAX_OUTCOME_GRACE_MINUTES)) {
    errors.push(`noShowGraceMinutes must be an integer between 0 and ${MAX_OUTCOME_GRACE_MINUTES}`);
  }
  errors.push(...validateBookingOutcomeRetentionRule(candidate.lateCancellationRetention, 'lateCancellationRetention'));
  errors.push(...validateBookingOutcomeRetentionRule(candidate.noShowRetention, 'noShowRetention'));
  return errors;
}

/**
 * Whether a structurally valid selection is inside a version's allowed
 * members. Returns every miss rather than the first, and names only the member,
 * never a value, so the result is safe to log.
 */
export function selectionOutsideAllowed(
  selection: BookingOutcomeSelectionV1,
  allowed: AllowedOutcomeMembersV1,
): readonly string[] {
  const misses: string[] = [];
  if (!allowed.cutoffHours.includes(selection.cutoffHours)) misses.push('cutoffHours');
  if (!allowed.noShowGraceMinutes.includes(selection.noShowGraceMinutes)) misses.push('noShowGraceMinutes');
  const late = retentionRuleIdentity(selection.lateCancellationRetention);
  if (!allowed.lateCancellationRetention.some((rule) => retentionRuleIdentity(rule) === late)) {
    misses.push('lateCancellationRetention');
  }
  const noShow = retentionRuleIdentity(selection.noShowRetention);
  if (!allowed.noShowRetention.some((rule) => retentionRuleIdentity(rule) === noShow)) misses.push('noShowRetention');
  return misses;
}

/** Two selections mean the same thing — the idempotent-replay test. */
export function sameOutcomeSelection(a: BookingOutcomeSelectionV1, b: BookingOutcomeSelectionV1): boolean {
  return (
    a.cutoffHours === b.cutoffHours &&
    a.noShowGraceMinutes === b.noShowGraceMinutes &&
    retentionRuleIdentity(a.lateCancellationRetention) === retentionRuleIdentity(b.lateCancellationRetention) &&
    retentionRuleIdentity(a.noShowRetention) === retentionRuleIdentity(b.noShowRetention)
  );
}

const TERMS_KEYS = [
  ...SELECTION_KEYS,
  'contractVersion',
  'rescheduleFreeCountBeforeCutoff',
  'disputeWindowHours',
  'bodilyHarmWindowHours',
  'appealWindowHours',
  'caseFileRetentionDays',
  'legalCap',
] as const;

export function validateBookingOutcomeTermsV1(terms: unknown): readonly string[] {
  const candidate = terms as Partial<BookingOutcomeTermsV1> | null;
  if (!candidate || typeof candidate !== 'object') return ['terms must be an object'];
  const errors: string[] = [];
  exactKeys(candidate, TERMS_KEYS, 'terms', errors);
  const selection: Record<string, unknown> = {};
  for (const key of SELECTION_KEYS) selection[key] = (candidate as Record<string, unknown>)[key];
  errors.push(...validateBookingOutcomeSelectionV1(selection));

  if (candidate.contractVersion !== BOOKING_OUTCOME_CONTRACT_VERSION) errors.push('contractVersion must be 1');
  if (!isWholeInRange(candidate.rescheduleFreeCountBeforeCutoff, 0, MAX_OUTCOME_RESCHEDULE_FREE_COUNT)) {
    errors.push(`rescheduleFreeCountBeforeCutoff must be an integer between 0 and ${MAX_OUTCOME_RESCHEDULE_FREE_COUNT}`);
  }
  if (!isWholeInRange(candidate.disputeWindowHours, 1, MAX_OUTCOME_HOURS)) {
    errors.push(`disputeWindowHours must be an integer between 1 and ${MAX_OUTCOME_HOURS}`);
  }
  if (candidate.bodilyHarmWindowHours !== null) {
    if (!isWholeInRange(candidate.bodilyHarmWindowHours, 1, MAX_OUTCOME_HOURS)) {
      errors.push(`bodilyHarmWindowHours must be null or an integer between 1 and ${MAX_OUTCOME_HOURS}`);
    } else if (
      isWholeInRange(candidate.disputeWindowHours, 1, MAX_OUTCOME_HOURS) &&
      candidate.bodilyHarmWindowHours < candidate.disputeWindowHours
    ) {
      errors.push('bodilyHarmWindowHours must not be shorter than disputeWindowHours');
    }
  }
  if (!isWholeInRange(candidate.appealWindowHours, 1, MAX_OUTCOME_HOURS)) {
    errors.push(`appealWindowHours must be an integer between 1 and ${MAX_OUTCOME_HOURS}`);
  }
  if (candidate.caseFileRetentionDays !== null && !isWholeInRange(candidate.caseFileRetentionDays, 1, MAX_OUTCOME_RETENTION_DAYS)) {
    errors.push(`caseFileRetentionDays must be null or an integer between 1 and ${MAX_OUTCOME_RETENTION_DAYS}`);
  }
  if (candidate.legalCap !== null) {
    const problems = validateBookingOutcomeRetentionRule(candidate.legalCap, 'legalCap');
    errors.push(...problems);
    if (problems.length === 0 && candidate.legalCap?.kind === 'none') errors.push('legalCap may not be of kind none; an absent cap is null');
  }
  return errors;
}

const SNAPSHOT_KEYS = ['policyKey', 'policyVersion', 'copyKey', 'copyVersion', 'resolvedAt', 'legalEvidenceId', 'terms'] as const;

export function validateBookingOutcomeSnapshotV1(snapshot: unknown): readonly string[] {
  const candidate = snapshot as Partial<BookingOutcomeSnapshotV1> | null;
  if (!candidate || typeof candidate !== 'object') return ['snapshot must be an object'];
  const errors: string[] = [];
  exactKeys(candidate, SNAPSHOT_KEYS, 'snapshot', errors);
  errors.push(...validateIdentity(candidate, 'snapshot'));
  if (typeof candidate.resolvedAt !== 'string' || !ISO_INSTANT_PATTERN.test(candidate.resolvedAt)) {
    errors.push('resolvedAt must be an ISO-8601 UTC instant');
  }
  errors.push(...validateBookingOutcomeTermsV1(candidate.terms));
  const hasCap = candidate.terms?.legalCap !== null && candidate.terms?.legalCap !== undefined;
  if (candidate.legalEvidenceId === null) {
    if (hasCap) errors.push('a legal cap requires its evidence reference');
  } else if (typeof candidate.legalEvidenceId !== 'string' || !UUID_PATTERN.test(candidate.legalEvidenceId)) {
    errors.push('legalEvidenceId must be null or a UUID');
  } else if (!hasCap) {
    errors.push('an evidence reference exists only together with a legal cap');
  }
  return errors;
}

const ACCEPTANCE_KEYS = ['policyKey', 'policyVersion', 'copyKey', 'copyVersion'] as const;

function validateIdentity(candidate: Partial<BookingOutcomeAcceptanceV1>, label: string): string[] {
  const errors: string[] = [];
  if (typeof candidate.policyKey !== 'string' || !BOOKING_OUTCOME_KEY_PATTERN.test(candidate.policyKey)) {
    errors.push(`${label}.policyKey has an invalid shape`);
  }
  if (!isWholeInRange(candidate.policyVersion, 1, 2_147_483_647)) errors.push(`${label}.policyVersion must be a positive integer`);
  if (typeof candidate.copyKey !== 'string' || !BOOKING_OUTCOME_KEY_PATTERN.test(candidate.copyKey)) {
    errors.push(`${label}.copyKey has an invalid shape`);
  }
  if (!isWholeInRange(candidate.copyVersion, 1, 2_147_483_647)) errors.push(`${label}.copyVersion must be a positive integer`);
  return errors;
}

export function validateBookingOutcomeAcceptanceV1(acceptance: unknown): readonly string[] {
  const candidate = acceptance as Partial<BookingOutcomeAcceptanceV1> | null;
  if (!candidate || typeof candidate !== 'object') return ['acceptedPolicy must be an object'];
  const errors: string[] = [];
  exactKeys(candidate, ACCEPTANCE_KEYS, 'acceptedPolicy', errors);
  errors.push(...validateIdentity(candidate, 'acceptedPolicy'));
  return errors;
}

/** The acceptance a customer must echo for a snapshot — exactly its four identifiers. */
export function acceptanceFor(snapshot: BookingOutcomeSnapshotV1): BookingOutcomeAcceptanceV1 {
  return {
    policyKey: snapshot.policyKey,
    policyVersion: snapshot.policyVersion,
    copyKey: snapshot.copyKey,
    copyVersion: snapshot.copyVersion,
  };
}

/** Whether an echoed acceptance names exactly the versions resolved now. No partial credit. */
export function acceptanceMatches(acceptance: BookingOutcomeAcceptanceV1, snapshot: BookingOutcomeSnapshotV1): boolean {
  return (
    acceptance.policyKey === snapshot.policyKey &&
    acceptance.policyVersion === snapshot.policyVersion &&
    acceptance.copyKey === snapshot.copyKey &&
    acceptance.copyVersion === snapshot.copyVersion
  );
}

/**
 * A retention rule as the three columns every #159 table stores it in, and
 * back. One mapping for the selection table (Commercial Policy) and the order
 * snapshot (Commerce), which may not import each other.
 *
 * The inverse is deliberately total: an unknown kind yields a rule the
 * validators reject, so a caller refuses rather than half-building a rule.
 */
export function bookingOutcomeRetentionColumns(rule: BookingOutcomeRetentionRule): {
  kind: string;
  basisPoints: number | null;
  amountToman: number | null;
} {
  return {
    kind: rule.kind,
    basisPoints: rule.kind === 'percentage_of_collected' ? rule.basisPoints : null,
    amountToman: rule.kind === 'fixed_toman' ? rule.amountToman : null,
  };
}

export function bookingOutcomeRetentionRuleFromColumns(
  kind: string,
  basisPoints: number | string | null,
  amountToman: number | string | null,
): BookingOutcomeRetentionRule {
  switch (kind) {
    case 'percentage_of_collected':
      return { kind, basisPoints: Number(basisPoints) };
    case 'fixed_toman':
      return { kind, amountToman: Number(amountToman) };
    case 'none':
    case 'full_collected':
      return { kind };
    default:
      return { kind } as unknown as BookingOutcomeRetentionRule;
  }
}

/** The copy locale vocabulary, re-exported under this contract's name for readers of the disclosure. */
export const BOOKING_OUTCOME_DISCLOSURE_LOCALES = CUSTOMER_POLICY_COPY_LOCALES;
