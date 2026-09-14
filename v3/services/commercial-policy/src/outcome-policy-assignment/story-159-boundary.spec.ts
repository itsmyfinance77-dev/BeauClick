import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Story #159 (`#42b`) stays inside its outcome — proved structurally against
 * the real files. It contains none of #160–#162, #43, #47 or #99; Commerce
 * imports no Commercial Policy implementation; the schedule is not altered;
 * nothing is seeded; no audit or log line carries a body, a reference or an
 * identity; and the superseded v1 contract is not reused.
 *
 * Mirrors `story-42a-boundary.spec.ts`: a detector, planted positives and
 * controls, so an empty finding list means something.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const COMMERCIAL_FILES = [
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.entities.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.exceptions.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-rows.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.service.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.controller.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-resolution.service.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment-subject-data.contract.ts',
  'services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.module.ts',
  'packages/commercial-policy-contract/src/booking-outcome-contract.ts',
];

const COMMERCE_FILES = [
  'services/commerce/src/ports.ts',
  'services/commerce/src/order/order.service.ts',
  'services/commerce/src/entities/order-outcome-terms.entity.ts',
  'services/commerce/src/commerce-subject-data.contract.ts',
];

const APP_FILES = ['apps/api/src/checkout/checkout-disclosure.ts', 'apps/api/src/checkout/checkout.controller.ts'];

const SELECTION_MIGRATION = 'database/migrations/commercial/20260919100001_create_seller_outcome_policy_assignments.sql';
const TERMS_MIGRATION = 'database/migrations/commerce/20260919100002_create_order_outcome_terms.sql';

export const LATER_STORY_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /booking_outcome_decisions|evaluateBookingOutcome|BookingOutcomeDecision|retentionAmount|computeRetention/, owner: '#160 (`#42c`) — the evaluator' },
  { pattern: /remainingRefundable|\.refund\(|recordRefund|PaymentService/, owner: '#160 (`#42c`) — refund execution' },
  { pattern: /no_show_declarations|NoShowDeclar|markNoShow|customer_remedy_choices|RemedyChoice/, owner: '#161 (`#42d`) — no-show and remedy' },
  { pattern: /dispute\.cases|DisputeCase|bc_review_disputes|case_statements|appealCase/, owner: '#162 (`#42e`) — the dispute case model' },
  { pattern: /commissionRate|commission_rate|settlement|pendingFunds|revenueRecogni/i, owner: '#43 — commission and settlement' },
  { pattern: /PaymentProvider|zarinpal/i, owner: '#47 — the production rail' },
  { pattern: /credit_purchases|custom_purchase/, owner: '#99 — paid credit activation' },
  { pattern: /BookingCommercialTermsV1|BookingCommercialPolicySnapshotV1|CommercialPolicyRegistry/, owner: 'ADR-051 §2 — the superseded v1 contract, not reused' },
];

export const FORBIDDEN_COMMERCE_REACH: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /from '@beauclick\/commercial-policy'/, why: 'the Commercial Policy implementation package' },
  { pattern: /BookingOutcomePolicyResolutionService|OutcomePolicyAssignmentService|BookingOutcomePolicyService/, why: 'a Commercial Policy service' },
  { pattern: /seller_outcome_policy_assignments|booking_outcome_policy_versions|customer_policy_copy_versions|legal_evidence_records/, why: 'a Commercial Policy table' },
];

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function findConstructs(file: string, source: string): string[] {
  const cleaned = stripComments(source);
  return LATER_STORY_CONSTRUCTS.filter(({ pattern }) => pattern.test(cleaned)).map(({ pattern, owner }) => `${file}: ${pattern} (${owner})`);
}

export function findCommerceReach(file: string, source: string): string[] {
  const cleaned = stripComments(source);
  return FORBIDDEN_COMMERCE_REACH.filter(({ pattern }) => pattern.test(cleaned)).map(({ pattern, why }) => `${file}: ${pattern} (${why})`);
}

const read = (file: string): string => readFileSync(resolve(WORKSPACE_ROOT, file), 'utf8');
const sqlOf = (file: string): string => read(file).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('Story #159 (`#42b`) stays inside its outcome', () => {
  const commercial = COMMERCIAL_FILES.map((file) => ({ file, source: read(file) }));
  const commerce = COMMERCE_FILES.map((file) => ({ file, source: read(file) }));
  const apps = APP_FILES.map((file) => ({ file, source: read(file) }));

  it('reads real files, so an empty finding list means something', () => {
    for (const { source } of [...commercial, ...commerce, ...apps]) expect(source.length).toBeGreaterThan(200);
    expect(read(TERMS_MIGRATION)).toContain('tg_ops_acceptance_requires_outcome_terms');
  });

  it('contains nothing owned by #160–#162, #43, #47 or #99, and does not reuse the superseded contract', () => {
    // Files #159 CREATED are scanned whole. Of the files it EDITED, only what it
    // added is scanned: `order.service.ts` and `checkout.controller.ts` carry
    // the pre-existing refund and payment paths, which are not this story's.
    const created = [
      ...commercial,
      { file: 'services/commerce/src/entities/order-outcome-terms.entity.ts', source: read('services/commerce/src/entities/order-outcome-terms.entity.ts') },
      { file: 'apps/api/src/checkout/checkout-disclosure.ts', source: read('apps/api/src/checkout/checkout-disclosure.ts') },
    ];
    const service = read('services/commerce/src/order/order.service.ts');
    const added = [
      /async previewForBooking\([\s\S]*?private async createForBookingWithin\(/.exec(service)?.[0] ?? '',
      /private outcomeForCollection\([\s\S]*?async recordVerifiedCapture\(/.exec(service)?.[0] ?? '',
    ];
    for (const region of added) expect(region.length).toBeGreaterThan(500);
    expect([
      ...created.flatMap(({ file, source }) => findConstructs(file, source)),
      ...added.flatMap((source) => findConstructs('order.service.ts (#159 regions)', source)),
    ]).toEqual([]);
  });

  it('keeps Commerce inside its scope: no Commercial Policy implementation, service or table', () => {
    expect(commerce.flatMap(({ file, source }) => findCommerceReach(file, source))).toEqual([]);
  });

  it('makes the outcome resolver a mandatory, Commerce-owned port bound once at the composition root', () => {
    const ports = stripComments(read('services/commerce/src/ports.ts'));
    expect(ports).toMatch(/resolveForSellerParty\(manager: EntityManager, sellerParty: OrderSellerParty\): Promise<ResolvedBookingOutcomePolicy>/);
    const service = stripComments(read('services/commerce/src/order/order.service.ts'));
    expect(service).toMatch(/@Inject\(BOOKING_OUTCOME_POLICY_RESOLVER\)\s*private readonly outcomePolicy/);
    expect(service).not.toMatch(/@Optional\(\)\s*@Inject\(BOOKING_OUTCOME_POLICY_RESOLVER\)/);
    const root = stripComments(read('apps/api/src/composition/domain-ports.module.ts'));
    expect(root.match(/provide: BOOKING_OUTCOME_POLICY_RESOLVER/g) ?? []).toHaveLength(1);
    expect(root).toMatch(/useExisting: CommercialPolicyBackedOutcomeResolver/);
  });

  it('never accepts a party, owner, business or professional id on the selection body or the acceptance', () => {
    const controller = stripComments(read('services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.controller.ts'));
    const dto = /export class AssignOutcomePolicyDto \{([\s\S]*?)\n\}/.exec(controller)![1];
    const fields = [...dto.matchAll(/^\s+([a-zA-Z]+)!:/gm)].map((m) => m[1]);
    expect(fields).toEqual(['policyKey', 'cutoffHours', 'lateCancellationRetention', 'noShowGraceMinutes', 'noShowRetention', 'reason']);

    const disclosure = stripComments(read('apps/api/src/checkout/checkout-disclosure.ts'));
    const accepted = /export class AcceptedPolicyDto \{([\s\S]*?)\n\}/.exec(disclosure)![1];
    expect([...accepted.matchAll(/^\s+([a-zA-Z]+)!:/gm)].map((m) => m[1])).toEqual(['policyKey', 'policyVersion', 'copyKey', 'copyVersion']);
    const query = /export class CheckoutDisclosureQueryDto \{([\s\S]*?)\n\}/.exec(disclosure)![1];
    expect([...query.matchAll(/^\s+([a-zA-Z]+)!:/gm)].map((m) => m[1])).toEqual(['professionalId', 'slotId', 'serviceId']);
  });

  it('puts no body, reference, evidence or identity into the acceptance log line or the selection audit', () => {
    const service = stripComments(read('services/commerce/src/order/order.service.ts'));
    const line = /action: 'order\.outcome_terms_accepted',([\s\S]*?)\}\);/.exec(service)![1];
    expect(line).not.toMatch(/body|workspaceRef|legalEvidence|customerId|sellerParty|phone/);
    const assignment = stripComments(read('services/commercial-policy/src/outcome-policy-assignment/outcome-policy-assignment.service.ts'));
    const audit = /function auditSnapshotOf\([\s\S]*?\n\}/.exec(assignment)![0];
    expect(audit).not.toMatch(/workspaceRef|partyId|party\.|body/);
  });

  it('seeds nothing, alters no existing table and puts DEFAULTs only on database clocks', () => {
    const selection = sqlOf(SELECTION_MIGRATION);
    const terms = sqlOf(TERMS_MIGRATION);
    for (const sql of [selection, terms]) {
      expect(sql).not.toMatch(/INSERT\s+INTO/i);
      expect(sql).not.toMatch(/\bUPDATE\s+(commerce|commercial)\./i);
      expect(sql).not.toMatch(/ALTER\s+TABLE/i);
      expect(sql).not.toMatch(/DROP\s+(TABLE|TRIGGER|CONSTRAINT|COLUMN)/i);
    }
    const defaults = [...(selection + terms).matchAll(/^\s*([a-z_]+)\s+[A-Z[\]()0-9]+.*\bDEFAULT\s+([^,\n]+)/gim)].map((m) => `${m[1]}=${m[2].trim()}`);
    expect(defaults.sort()).toEqual(['assigned_at=now()', 'resolved_at=now()']);
    // The schedule gains a constraint trigger and nothing else.
    expect(terms.match(/ON commerce\.order_payment_schedules/g) ?? []).toHaveLength(1);
    expect(selection).not.toMatch(/\bcommerce\./);
  });

  it('leaves the superseded v1 contract, the collection contract and the registry byte-identical', () => {
    // Pinned by hash in `story-42a-boundary.spec.ts`; restated as a marker here
    // so this story's own suite fails if it ever reaches into them.
    expect(read('packages/commercial-policy-contract/src/commercial-policy-contract.ts')).not.toMatch(/BookingOutcome|acceptedPolicy/);
    expect(read('packages/commercial-policy-contract/src/booking-collection-policy-contract.ts')).not.toMatch(/BookingOutcome|acceptedPolicy/);
  });

  describe('the detectors are not vacuous', () => {
    it.each([
      ['the evaluator', 'evaluateBookingOutcome(input);'],
      ['a refund', 'await this.payments.refund({});'],
      ['a no-show declaration', "await m.insert('no_show_declarations', {});"],
      ['a dispute', 'class DisputeCase {}'],
      ['settlement', 'const settlement = 1;'],
      ['the superseded contract', 'const t: BookingCommercialPolicySnapshotV1 = {};'],
    ])('finds %s when it is planted', (_label, planted) => {
      expect(findConstructs('planted.ts', planted)).not.toEqual([]);
    });

    it.each([
      ['the implementation package', "import { X } from '@beauclick/commercial-policy';"],
      ['the resolver class', 'constructor(private readonly r: BookingOutcomePolicyResolutionService) {}'],
      ['a commercial table', "await m.query('SELECT 1 FROM commercial.seller_outcome_policy_assignments');"],
    ])('finds Commerce reaching %s when it is planted', (_label, planted) => {
      expect(findCommerceReach('planted.ts', planted)).not.toEqual([]);
    });

    it('does NOT fire on the same words inside a comment, and permits the shared contract', () => {
      const documented = `
        // The evaluator is #160's: evaluateBookingOutcome does not exist here.
        /* seller_outcome_policy_assignments is Commercial Policy's table. */
        import type { BookingOutcomeSnapshotV1 } from '@beauclick/commercial-policy-contract';
      `;
      expect(findConstructs('documented.ts', documented)).toEqual([]);
      expect(findCommerceReach('documented.ts', documented)).toEqual([]);
    });
  });
});
