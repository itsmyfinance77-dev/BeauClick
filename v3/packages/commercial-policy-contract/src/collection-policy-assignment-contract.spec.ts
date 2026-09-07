import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH,
  COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH,
  COLLECTION_POLICY_ASSIGNMENT_REFUSAL_CAUSES,
  COLLECTION_POLICY_ASSIGNMENT_UNAVAILABLE,
  COLLECTION_POLICY_KEY_MAX_LENGTH,
  COLLECTION_POLICY_KEY_PATTERN,
  validateAssignCollectionPolicyRequestV1,
} from './index';

/**
 * The seller assignment contract — V3.3 Story #104 (`#41d-2a`).
 *
 * Two things are proved here that the real-PostgreSQL suite cannot: the shape
 * of the request at run time, and that the projections carry nothing they must
 * not. Everything about locking, uniqueness, immutability and audit belongs to
 * the database and is proved against a real server.
 */
describe('collection policy assignment contract (#41d-2a)', () => {
  describe('§1 request validation', () => {
    it('accepts a well-formed request', () => {
      expect(validateAssignCollectionPolicyRequestV1({ policyKey: 'standard-deposit', reason: 'going live' })).toEqual(
        [],
      );
    });

    it('refuses a malformed key, and returns every problem rather than the first', () => {
      const problems = validateAssignCollectionPolicyRequestV1({ policyKey: '9-starts-with-a-digit', reason: 'x' });
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/policyKey/);
      expect(problems[1]).toMatch(/reason/);
    });

    it('refuses a missing key and a missing reason without coercing either', () => {
      // `RegExp.test(undefined)` stringifies to "undefined", which matches this
      // pattern -- so the validator narrows with `typeof` FIRST. The
      // pre-existing `customerPolicyCopyVersion` hole in
      // `validateBookingCommercialTermsV1` is exactly that mistake, and this
      // case is the proof this contract does not repeat it.
      expect(COLLECTION_POLICY_KEY_PATTERN.test('undefined')).toBe(true);
      const problems = validateAssignCollectionPolicyRequestV1({});
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/policyKey/);
    });

    it('refuses a whitespace-only reason, which a length check alone would accept', () => {
      expect(validateAssignCollectionPolicyRequestV1({ policyKey: 'k', reason: '   ' })).toContain(
        `reason must be ${COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH}-${COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH} characters once trimmed`,
      );
    });

    it('accepts a key at the database bound and refuses one past it', () => {
      const atBound = 'a'.repeat(COLLECTION_POLICY_KEY_MAX_LENGTH);
      const pastBound = 'a'.repeat(COLLECTION_POLICY_KEY_MAX_LENGTH + 1);
      expect(validateAssignCollectionPolicyRequestV1({ policyKey: atBound, reason: 'fine' })).toEqual([]);
      expect(validateAssignCollectionPolicyRequestV1({ policyKey: pastBound, reason: 'fine' })[0]).toMatch(/policyKey/);
    });

    it('refuses a reason past the audit column bound', () => {
      const tooLong = 'x'.repeat(COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH + 1);
      expect(validateAssignCollectionPolicyRequestV1({ policyKey: 'k', reason: tooLong })[0]).toMatch(/reason/);
    });
  });

  describe('§2 the closed vocabularies', () => {
    it('publishes exactly one public refusal code', () => {
      expect(COLLECTION_POLICY_ASSIGNMENT_UNAVAILABLE).toBe('collection_policy_assignment_unavailable');
    });

    it('keeps the internal cause vocabulary closed, low-cardinality and identity-free', () => {
      expect([...COLLECTION_POLICY_ASSIGNMENT_REFUSAL_CAUSES]).toEqual([
        'workspace_unresolvable',
        'policy_unavailable',
        'assignment_conflict',
      ]);
      // A bounded label set: every member is a bare enum value carrying no id,
      // reference, key, amount or prose.
      for (const cause of COLLECTION_POLICY_ASSIGNMENT_REFUSAL_CAUSES) {
        expect(cause).toMatch(/^[a-z_]+$/);
      }
    });
  });

  describe('§3 the projections carry nothing they must not', () => {
    const source = readFileSync(join(__dirname, 'collection-policy-assignment-contract.ts'), 'utf8');
    const declarations = source
      .split('\n')
      .filter((line) => /^\s+readonly \w+/.test(line))
      .join('\n');

    it('exposes only a stable key and a display name on an assignable policy', () => {
      // The whole seller-visible surface is these five field names -- `items`
      // and `assignment` are the two wrappers, and the other three are the data.
      // Anchored at the line start and requiring the colon: `readonly items:
      // readonly AssignableCollectionPolicyV1[]` contains a second `readonly`
      // that belongs to the array TYPE, not to a field.
      const fields = [...declarations.matchAll(/^\s+readonly (\w+):/gm)].map((m) => m[1]);
      expect(new Set(fields)).toEqual(
        new Set(['policyKey', 'displayName', 'assignedAt', 'assignment', 'items']),
      );
    });

    it.each([
      'policyVersion',
      'version',
      'collectionMode',
      'deposit',
      'basisPoints',
      'amountToman',
      'percentageBase',
      'activationStartsAt',
      'activationEndsAt',
      'lifecycleState',
      'createdByUserId',
      'publishedByUserId',
      'retiredByUserId',
      'supersededAt',
      'supersededBy',
      'reason',
      'id',
      'policyAcceptedAt',
      'acceptedAt',
    ])('declares no %s field anywhere in the seller projections', (forbidden) => {
      expect(declarations).not.toMatch(new RegExp(`readonly ${forbidden}\\b`));
    });

    it('never names an acceptance instant, which stays #42’s after Legal', () => {
      expect(source).not.toMatch(/readonly (policyAcceptedAt|acceptedAt)/);
    });
  });
});
