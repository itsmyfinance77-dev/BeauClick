/**
 * The browser-safe seller surface for collection-policy assignment — V3.3
 * Story #104 (`#41d-2a`), ADR-048 R2, `V33-DEC-031` R1 and R4.
 *
 * Zero dependencies, like every other file in this package. No NestJS, no
 * TypeORM, no entity, no user id, no party id and no gateway.
 *
 * ## Every type here is a PROJECTION, and the omissions are the contract
 *
 * A seller may learn two things: which policies they could choose, and which
 * one they have chosen. Neither answer contains a version number, terms, a
 * collection mode, an amount, a percentage, a calculation base, an activation
 * window, a lifecycle value, an actor id, an audit field, a reason, an
 * assignment id or any retirement internal. Those are administrative facts
 * about the catalogue, and `CommercialCatalogueController` already draws that
 * line for plans; this draws the same one for collection policy.
 *
 * ## `assignment: null` is a state, not an error
 *
 * A live-owned workspace with no current assignment is **unenrolled**, which
 * `V33-DEC-029` Ruling 8 and ADR-048 R2 make a first-class state: it keeps the
 * legacy order path. The read returns it successfully rather than refusing, and
 * nothing about the response invites a client to auto-create anything.
 */

/** The prefix every collection-policy key shares with the rest of the catalogue. */
export const COLLECTION_POLICY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Bounds mirrored from the database, so a client and the server agree on what is submittable. */
export const COLLECTION_POLICY_KEY_MAX_LENGTH = 64;
export const COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH = 3;
export const COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH = 500;

/**
 * One assignable policy, as a seller sees it.
 *
 * Exactly a stable selection identity and a display string. `displayName` is
 * the administrator's own administrative label, which is prose about the
 * policy and never customer-facing legal copy — that remains `V33-DEC-017`,
 * open on #42 and Legal.
 */
export interface AssignableCollectionPolicyV1 {
  readonly policyKey: string;
  readonly displayName: string;
}

export interface AssignableCollectionPolicyListV1 {
  readonly items: readonly AssignableCollectionPolicyV1[];
}

/**
 * The seller's current choice.
 *
 * `assignedAt` is the instant the seller made it — their own action, on their
 * own workspace — and is therefore theirs to see. `supersededAt` is absent by
 * construction: a superseded row is not current, so it is never projected.
 */
export interface CurrentCollectionPolicyAssignmentV1 {
  readonly policyKey: string;
  readonly displayName: string;
  readonly assignedAt: string;
}

/** `assignment: null` means the workspace is unenrolled, which is a legitimate state. */
export interface CollectionPolicyAssignmentViewV1 {
  readonly assignment: CurrentCollectionPolicyAssignmentV1 | null;
}

/**
 * The one public refusal code for this surface.
 *
 * Lower-case to match `purchase_unavailable`, the precedent `V33-DEC-026`
 * Ruling 8 set and `V33-DEC-031` R4 continues: one code, one body, one status
 * for every cause, so the catalogue cannot be enumerated one refusal at a time.
 */
export const COLLECTION_POLICY_ASSIGNMENT_UNAVAILABLE = 'collection_policy_assignment_unavailable' as const;

/**
 * The closed internal cause vocabulary.
 *
 * Never serialised into a response. It exists so an operator can see WHY
 * refusals are happening without the platform telling a caller which of these
 * applied to them. Every member is a bare enum value carrying no identity, no
 * workspace reference, no policy key, no money and no request prose — the
 * bounded-label rule `V33-DEC-031` R4 requires of a metric.
 */
export const COLLECTION_POLICY_ASSIGNMENT_REFUSAL_CAUSES = [
  'workspace_unresolvable',
  'policy_unavailable',
  'assignment_conflict',
] as const;
export type CollectionPolicyAssignmentRefusalCause =
  (typeof COLLECTION_POLICY_ASSIGNMENT_REFUSAL_CAUSES)[number];

/** Returns every structural problem, rather than hiding the second behind the first. */
export function validateAssignCollectionPolicyRequestV1(request: {
  policyKey?: unknown;
  reason?: unknown;
}): readonly string[] {
  const errors: string[] = [];

  if (typeof request.policyKey !== 'string' || !COLLECTION_POLICY_KEY_PATTERN.test(request.policyKey)) {
    errors.push(
      `policyKey must be 1-${COLLECTION_POLICY_KEY_MAX_LENGTH} characters of [A-Za-z0-9_-] starting with a letter`,
    );
  }

  if (typeof request.reason !== 'string') {
    errors.push('reason must be a string');
  } else {
    const trimmed = request.reason.trim();
    if (
      trimmed.length < COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH ||
      trimmed.length > COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH
    ) {
      errors.push(
        `reason must be ${COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH}-${COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH} characters once trimmed`,
      );
    }
  }

  return errors;
}
