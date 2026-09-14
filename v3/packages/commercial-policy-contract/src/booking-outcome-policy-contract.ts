/**
 * The administrator-authored booking-outcome policy family, the Persian
 * customer-policy copy family and the Legal-evidence record — V3.3 Story #42
 * (`#42a`), ADR-051 §1, §5 and §10, `V33-DEC-039`, `V33-DEC-042`, `V33-DEC-043`.
 *
 * ## What this contract is
 *
 * The request and read vocabulary of the PUBLICATION plane: what an
 * administrator may author, version, publish and retire. It carries **ranges
 * and sets a seller will later choose inside** (`#42b`, #159), never a single
 * value handed to a seller, and never the snapshot a booking will carry — that
 * is `BookingOutcomeTermsV1`, introduced by `#42b` and deliberately absent here.
 *
 * ## What it supersedes, and does not touch
 *
 * ADR-051 §2 supersedes `BookingCommercialTermsV1` (`./commercial-policy-contract.ts`)
 * for this programme. That contract, `BookingCollectionTermsV1` and the
 * in-memory registry are **byte-for-byte unchanged** by this file; this is a
 * new, additive export.
 *
 * ## No value lives here
 *
 * Every number below is either a closed vocabulary member or a REPRESENTATIONAL
 * bound (what the column can hold), exactly as `MAX_UNIT_PRICE_TOMAN` is. The
 * owner-endorsed initial publication values of `V33-DEC-039` — 24 h, 15 min,
 * 72 h — appear nowhere in this package, in any migration or in any default:
 * an administrator publishes them, or nothing exists (`V33-DEC-028` Ruling 2).
 */

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** The lifecycle is the catalogue's own: `draft -> published -> retired`, one way. */
export { CATALOGUE_LIFECYCLE_STATES as BOOKING_OUTCOME_LIFECYCLE_STATES } from './commercial-catalogue-contract';

/** Which outcome a retention option applies to (ADR-051 §1). */
export const BOOKING_OUTCOME_RETENTION_PURPOSES = ['late_cancellation', 'no_show'] as const;
export type BookingOutcomeRetentionPurpose = (typeof BOOKING_OUTCOME_RETENTION_PURPOSES)[number];

/**
 * The closed retention-rule shapes `V33-DEC-039` R5 ratified. `none` retains
 * nothing; `full_collected` retains the whole remaining collected amount; the
 * other two carry exactly one numeric field each. Nothing here is a value.
 */
export const BOOKING_OUTCOME_RETENTION_KINDS = [
  'none',
  'percentage_of_collected',
  'fixed_toman',
  'full_collected',
] as const;
export type BookingOutcomeRetentionKind = (typeof BOOKING_OUTCOME_RETENTION_KINDS)[number];

/** `recorded -> retired`, one way (ADR-051 §5). */
export const LEGAL_EVIDENCE_STATUSES = ['recorded', 'retired'] as const;
export type LegalEvidenceStatus = (typeof LEGAL_EVIDENCE_STATUSES)[number];

/**
 * What an evidence record attests to. Only `retention_cap` qualifies a
 * `legalCap` publication; the other three exist so a later story can reference
 * evidence for its own gate without widening this vocabulary silently.
 */
export const LEGAL_EVIDENCE_SUBJECTS = [
  'retention_cap',
  'withdrawal_posture',
  'policy_copy',
  'case_file_retention',
] as const;
export type LegalEvidenceSubject = (typeof LEGAL_EVIDENCE_SUBJECTS)[number];

/** The subject that qualifies a `legalCap`. Spelled once, read by the trigger's mirror in tests. */
export const LEGAL_EVIDENCE_SUBJECT_FOR_CAP: LegalEvidenceSubject = 'retention_cap';

/** The record stores a REFERENCE and a summary, never the document (ADR-051 §5). */
export const LEGAL_EVIDENCE_REFERENCE_KINDS = ['document_reference', 'counsel_letter_reference', 'internal_ticket'] as const;
export type LegalEvidenceReferenceKind = (typeof LEGAL_EVIDENCE_REFERENCE_KINDS)[number];

/** The only locale this contract carries. A second locale is a later decision, not a default. */
export const CUSTOMER_POLICY_COPY_LOCALES = ['fa-IR'] as const;
export type CustomerPolicyCopyLocale = (typeof CUSTOMER_POLICY_COPY_LOCALES)[number];

// ---------------------------------------------------------------------------
// Representational bounds — what a column can hold, never what it should
// ---------------------------------------------------------------------------

export const BOOKING_OUTCOME_CONTRACT_VERSION = 1 as const;

/** SMALLINT-representable and physically meaningful: one year of hours, one day of minutes. */
export const MAX_OUTCOME_HOURS = 8_760;
export const MAX_OUTCOME_GRACE_MINUTES = 1_440;
export const MAX_OUTCOME_RETENTION_DAYS = 3_650;
export const MAX_OUTCOME_RESCHEDULE_FREE_COUNT = 100;
/** The same ceiling `MAX_UNIT_PRICE_TOMAN` and `MAX_COLLECTION_AMOUNT_TOMAN` use. */
export const MAX_OUTCOME_AMOUNT_TOMAN = 10_000_000_000_000;
/** How many members one allowed set may carry. Bounds the request, not the product. */
export const MAX_OUTCOME_SET_MEMBERS = 64;
export const MAX_OUTCOME_RETENTION_OPTIONS = 32;
/** The Persian body is data, bounded so a request cannot carry a document. */
export const MAX_CUSTOMER_POLICY_COPY_BYTES = 65_536;
export const MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH = 512;
export const MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH = 1_000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type NoRetentionRule = Readonly<{ kind: 'none' }>;
export type FullCollectedRetentionRule = Readonly<{ kind: 'full_collected' }>;
/**
 * Integer basis points of the remaining collected amount. `1..9_999` and not
 * `0..10_000`: zero IS `none` and ten thousand IS `full_collected`, and one
 * option per meaning is what keeps a published set unambiguous.
 */
export type PercentageOfCollectedRetentionRule = Readonly<{ kind: 'percentage_of_collected'; basisPoints: number }>;
/** Integer toman, positive: zero IS `none`. */
export type FixedTomanRetentionRule = Readonly<{ kind: 'fixed_toman'; amountToman: number }>;

export type BookingOutcomeRetentionRule =
  | NoRetentionRule
  | FullCollectedRetentionRule
  | PercentageOfCollectedRetentionRule
  | FixedTomanRetentionRule;

/**
 * One version of the numeric family, as an administrator authors it.
 *
 * Two sets and two option lists a seller chooses INSIDE (`#42b`), and the
 * administrator-fixed values `V33-DEC-039` R8–R12 name. `legalCap` is the one
 * field that cannot be published on its own authority: ADR-051 §5 makes a
 * published version with a cap unwritable unless it references a recorded
 * `retention_cap` evidence record, and that reference is NOT part of these
 * terms — it is a separate input, so the terms can be validated with no
 * knowledge of what evidence exists.
 */
export interface BookingOutcomePolicyVersionTermsV1 {
  readonly contractVersion: typeof BOOKING_OUTCOME_CONTRACT_VERSION;
  /** Whole hours before the scheduled start; non-empty, strictly ascending. */
  readonly cutoffHoursAllowed: readonly number[];
  /** Non-empty; one option per meaning (ADR-051 §1). */
  readonly lateRetentionOptions: readonly BookingOutcomeRetentionRule[];
  /** Whole minutes after the scheduled start; non-empty, strictly ascending. */
  readonly noShowGraceMinutesAllowed: readonly number[];
  readonly noShowRetentionOptions: readonly BookingOutcomeRetentionRule[];
  readonly rescheduleFreeCountBeforeCutoff: number;
  readonly disputeWindowHours: number;
  /** Nullable; when present, never shorter than the normal window (`V33-DEC-039` R9). */
  readonly bodilyHarmWindowHours: number | null;
  readonly appealWindowHours: number;
  /** Nullable: "unconfigured" is a state, never a defaulted number (ADR-051 §10). */
  readonly caseFileRetentionDays: number | null;
  /** Nullable: absent means retention cannot exceed zero (`V33-DEC-039` R5). */
  readonly legalCap: BookingOutcomeRetentionRule | null;
}

/** One version of the text family. It carries NO number by construction. */
export interface CustomerPolicyCopyVersionTermsV1 {
  readonly contractVersion: typeof BOOKING_OUTCOME_CONTRACT_VERSION;
  readonly locale: CustomerPolicyCopyLocale;
  readonly body: string;
}

/** What an administrator records about a piece of Legal evidence. Never the evidence. */
export interface LegalEvidenceRecordInputV1 {
  readonly subject: LegalEvidenceSubject;
  readonly referenceKind: LegalEvidenceReferenceKind;
  readonly reference: string;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Validators. Shape only; the database CHECKs are the authoritative layer.
// ---------------------------------------------------------------------------

/** UTF-8 byte length without `Buffer`, because this package is browser-safe. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one four-byte scalar; skip its low half.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isWholeInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validateAscendingSet(
  label: string,
  values: readonly number[] | undefined,
  min: number,
  max: number,
  errors: string[],
): void {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  if (values.length > MAX_OUTCOME_SET_MEMBERS) errors.push(`${label} may carry at most ${MAX_OUTCOME_SET_MEMBERS} members`);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isWholeInRange(value, min, max)) {
      errors.push(`${label}[${index}] must be an integer between ${min} and ${max}`);
      continue;
    }
    if (index > 0 && !(value > values[index - 1])) errors.push(`${label} must be strictly ascending`);
  }
}

export function validateBookingOutcomeRetentionRule(rule: unknown, label: string): readonly string[] {
  const errors: string[] = [];
  const candidate = rule as { kind?: unknown; basisPoints?: unknown; amountToman?: unknown } | null;
  if (!candidate || typeof candidate !== 'object') return [`${label} must be a retention rule`];
  const kind = candidate.kind;
  if (!(BOOKING_OUTCOME_RETENTION_KINDS as readonly unknown[]).includes(kind)) {
    return [`${label}.kind is not a retention kind`];
  }
  const keys = Object.keys(candidate).filter((key) => key !== 'kind');
  switch (kind) {
    case 'none':
    case 'full_collected':
      if (keys.length > 0) errors.push(`${label} of kind ${kind} carries no numeric field`);
      break;
    case 'percentage_of_collected':
      if (!isWholeInRange(candidate.basisPoints, 1, 9_999)) {
        errors.push(`${label}.basisPoints must be an integer between 1 and 9999`);
      }
      if (keys.some((key) => key !== 'basisPoints')) errors.push(`${label} of kind percentage_of_collected carries only basisPoints`);
      break;
    case 'fixed_toman':
      if (!isWholeInRange(candidate.amountToman, 1, MAX_OUTCOME_AMOUNT_TOMAN)) {
        errors.push(`${label}.amountToman must be a positive safe integer`);
      }
      if (keys.some((key) => key !== 'amountToman')) errors.push(`${label} of kind fixed_toman carries only amountToman`);
      break;
    default:
      errors.push(`${label}.kind is not a retention kind`);
  }
  return errors;
}

/** One option per meaning: two `none`, two identical percentages or two identical amounts are a duplicate. */
export function retentionRuleIdentity(rule: BookingOutcomeRetentionRule): string {
  switch (rule.kind) {
    case 'percentage_of_collected':
      return `percentage_of_collected:${rule.basisPoints}`;
    case 'fixed_toman':
      return `fixed_toman:${rule.amountToman}`;
    default:
      return rule.kind;
  }
}

function validateRetentionOptions(
  label: string,
  options: readonly unknown[] | undefined,
  errors: string[],
): void {
  if (!Array.isArray(options) || options.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  if (options.length > MAX_OUTCOME_RETENTION_OPTIONS) {
    errors.push(`${label} may carry at most ${MAX_OUTCOME_RETENTION_OPTIONS} options`);
  }
  const seen = new Set<string>();
  options.forEach((option, index) => {
    const problems = validateBookingOutcomeRetentionRule(option, `${label}[${index}]`);
    errors.push(...problems);
    if (problems.length === 0) {
      const identity = retentionRuleIdentity(option as BookingOutcomeRetentionRule);
      if (seen.has(identity)) errors.push(`${label} carries the option ${identity} more than once`);
      seen.add(identity);
    }
  });
}

export function validateBookingOutcomePolicyVersionTermsV1(
  terms: BookingOutcomePolicyVersionTermsV1,
): readonly string[] {
  const errors: string[] = [];
  if (!terms || typeof terms !== 'object') return ['terms must be an object'];
  if (terms.contractVersion !== BOOKING_OUTCOME_CONTRACT_VERSION) errors.push('contractVersion must be 1');

  validateAscendingSet('cutoffHoursAllowed', terms.cutoffHoursAllowed, 0, MAX_OUTCOME_HOURS, errors);
  validateRetentionOptions('lateRetentionOptions', terms.lateRetentionOptions, errors);
  validateAscendingSet('noShowGraceMinutesAllowed', terms.noShowGraceMinutesAllowed, 0, MAX_OUTCOME_GRACE_MINUTES, errors);
  validateRetentionOptions('noShowRetentionOptions', terms.noShowRetentionOptions, errors);

  if (!isWholeInRange(terms.rescheduleFreeCountBeforeCutoff, 0, MAX_OUTCOME_RESCHEDULE_FREE_COUNT)) {
    errors.push(`rescheduleFreeCountBeforeCutoff must be an integer between 0 and ${MAX_OUTCOME_RESCHEDULE_FREE_COUNT}`);
  }
  if (!isWholeInRange(terms.disputeWindowHours, 1, MAX_OUTCOME_HOURS)) {
    errors.push(`disputeWindowHours must be an integer between 1 and ${MAX_OUTCOME_HOURS}`);
  }
  if (terms.bodilyHarmWindowHours !== null) {
    if (!isWholeInRange(terms.bodilyHarmWindowHours, 1, MAX_OUTCOME_HOURS)) {
      errors.push(`bodilyHarmWindowHours must be null or an integer between 1 and ${MAX_OUTCOME_HOURS}`);
    } else if (Number.isInteger(terms.disputeWindowHours) && terms.bodilyHarmWindowHours < terms.disputeWindowHours) {
      errors.push('bodilyHarmWindowHours cannot be shorter than disputeWindowHours');
    }
  }
  if (!isWholeInRange(terms.appealWindowHours, 1, MAX_OUTCOME_HOURS)) {
    errors.push(`appealWindowHours must be an integer between 1 and ${MAX_OUTCOME_HOURS}`);
  }
  if (terms.caseFileRetentionDays !== null && !isWholeInRange(terms.caseFileRetentionDays, 1, MAX_OUTCOME_RETENTION_DAYS)) {
    errors.push(`caseFileRetentionDays must be null or an integer between 1 and ${MAX_OUTCOME_RETENTION_DAYS}`);
  }
  if (terms.legalCap !== null) {
    if (terms.legalCap === undefined) {
      errors.push('legalCap must be null or a retention rule');
    } else {
      errors.push(...validateBookingOutcomeRetentionRule(terms.legalCap, 'legalCap'));
      if (terms.legalCap && (terms.legalCap as BookingOutcomeRetentionRule).kind === 'none') {
        errors.push('legalCap of kind none is the absence of a cap: send null instead');
      }
    }
  }
  return errors;
}

export function validateCustomerPolicyCopyVersionTermsV1(terms: CustomerPolicyCopyVersionTermsV1): readonly string[] {
  const errors: string[] = [];
  if (!terms || typeof terms !== 'object') return ['terms must be an object'];
  if (terms.contractVersion !== BOOKING_OUTCOME_CONTRACT_VERSION) errors.push('contractVersion must be 1');
  if (!(CUSTOMER_POLICY_COPY_LOCALES as readonly unknown[]).includes(terms.locale)) errors.push('locale must be fa-IR');
  if (typeof terms.body !== 'string' || terms.body.trim().length === 0) {
    errors.push('body must be a non-empty string');
  } else if (utf8ByteLength(terms.body) > MAX_CUSTOMER_POLICY_COPY_BYTES) {
    errors.push(`body may carry at most ${MAX_CUSTOMER_POLICY_COPY_BYTES} bytes`);
  }
  return errors;
}

export function validateLegalEvidenceRecordInputV1(input: LegalEvidenceRecordInputV1): readonly string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return ['input must be an object'];
  if (!(LEGAL_EVIDENCE_SUBJECTS as readonly unknown[]).includes(input.subject)) errors.push('subject is not a Legal-evidence subject');
  if (!(LEGAL_EVIDENCE_REFERENCE_KINDS as readonly unknown[]).includes(input.referenceKind)) {
    errors.push('referenceKind is not a Legal-evidence reference kind');
  }
  if (typeof input.reference !== 'string' || input.reference.trim().length === 0 || input.reference.length > MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH) {
    errors.push(`reference must be 1-${MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH} characters`);
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0 || input.summary.length > MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH) {
    errors.push(`summary must be 1-${MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH} characters`);
  }
  return errors;
}
