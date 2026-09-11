/**
 * Dependency-free constants of the booking-credit enforcement control plane
 * -- V3.3 Story #95 (`#58b-1`), ADR-050. Kept apart from the services so the
 * fast contract spec and other modules can pin them without pulling in the
 * ledger.
 */

/**
 * The advisory-lock namespace for global activation / governance
 * coordination -- V3.3 #95 (`#58b-1`), ADR-050 §7.2, `V33-DEC-036` R10.
 *
 * `0x62_63_67_76` is ASCII `bcgv`, distinct from every other namespace in the
 * repository (`aicn`, `bkas`, `srrq`, `bcre`, `wish`), and asserted distinct by
 * the repository-wide uniqueness test. ONE fixed key (`0`) lives in it:
 *
 *   * SHARED  -- explicit transition and exemption (this story), and #141's
 *                seller-creation hook: many may run at once;
 *   * EXCLUSIVE -- #141's activation, which must wait for every shared holder
 *                and exclude new ones while it verifies "no unresolved
 *                seller" at its commit instant.
 *
 * Nothing in #95 takes the exclusive form. It is named here, and the shared
 * form is taken here, so that activation later locks against the commands
 * that already exist rather than against a convention.
 */
export const BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE = 0x62_63_67_76 | 0;
export const BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY = 0;

/** The audit `target_type` every enforcement action reports against. */
export const AUDIT_TARGET_ENFORCEMENT = 'commercial.booking_credit_enforcement';

/** The closed audit vocabulary (ADR-050 §8). Server-authored; nothing caller-supplied. */
export const ENFORCEMENT_AUDIT_ACTIONS = {
  partiesGoverned: 'commercial.enforcement_parties_governed',
  partiesExempted: 'commercial.enforcement_parties_exempted',
  killSwitchEngaged: 'commercial.enforcement_kill_switch_engaged',
  killSwitchReleased: 'commercial.enforcement_kill_switch_released',
} as const;

/**
 * THE eligibility predicate -- ADR-050 §3.1, expressed exactly once.
 *
 * An eligible seller party is a non-deleted professional or a non-deleted
 * business. Nothing else: `verification_status` is not consulted (no
 * confirmation path consults it either), `business_staff` affiliation grants
 * nothing, a user owning both is two parties, and the subscription state is
 * irrelevant. Preview, transition, exemption and -- later -- #141's activation
 * all embed this one fragment; a second copy is the drift `V33-DEC-036` R6
 * and R9 forbid, and the contract spec counts the definition sites.
 */
export const ELIGIBLE_PARTIES_SQL = `
  SELECT 'professional'::text AS party_type, p.id AS party_id
    FROM provider.professionals p
   WHERE p.deleted_at IS NULL
  UNION ALL
  SELECT 'business'::text AS party_type, b.id AS party_id
    FROM business.businesses b
   WHERE b.deleted_at IS NULL`;
