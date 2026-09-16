import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Story #160 (`#42c`) stays inside its outcome — proved structurally against
 * the real files. It contains none of #162, #43, #47 or #99; it writes
 * no ledger row and emits no event; Commerce imports no other domain; the
 * evaluator is pure; the migration seeds and alters nothing; no audit or log
 * line carries an amount, a cap or evidence; and the superseded v1 contract is
 * not reused.
 *
 * Mirrors `story-159-boundary.spec.ts`: a detector, planted positives and
 * controls, so an empty finding list means something.
 *
 * ## The #161 entry, retired 2026-09-21
 *
 * `LATER_STORY_CONSTRUCTS` originally forbade `no_show_declarations` /
 * `customer_remedy_choices` vocabulary in these same six files, exactly
 * because ADR-051 §7/§8 name `#161` (`#42d`) as the story that extends this
 * evaluator, this decision service and this orchestrator to build them. Now
 * that #161 is that story, the entry is removed rather than dodged by
 * contorted naming — the remaining entries (#162, #43, #47, #99, the
 * superseded v1 contract, no new outbox event, no route/capability) are
 * still #161's own boundaries and are unchanged.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const EVALUATOR = 'services/commercial-policy/src/outcome-evaluation/evaluate-booking-outcome.ts';
const EVIDENCE_STATE = 'services/commercial-policy/src/outcome-evaluation/legal-evidence-state.service.ts';
const CONTRACT = 'packages/commercial-policy-contract/src/booking-outcome-decision-contract.ts';
const DECISION_SERVICE = 'services/commerce/src/outcome-decision/booking-outcome-decision.service.ts';
const ORCHESTRATOR = 'apps/api/src/outcome/booking-outcome.orchestrator.ts';
const COMPOSITION = 'apps/api/src/composition/booking-outcome-composition.module.ts';
const MIGRATION = 'database/migrations/commerce/20260920100001_create_booking_outcome_decisions.sql';

const CREATED_FILES = [EVALUATOR, EVIDENCE_STATE, CONTRACT, DECISION_SERVICE, ORCHESTRATOR, COMPOSITION];

export const LATER_STORY_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /dispute\.cases|DisputeCase|bc_review_disputes|case_statements|appealCase|held_toman/, owner: '#162 (`#42e`) — the dispute case model' },
  { pattern: /commissionRate|commission_rate|settlement|pendingFunds|revenueRecogni|LedgerService|recordPayment\(|financial\./i, owner: '#43 — commission, ledger and settlement' },
  { pattern: /PaymentProvider\b|zarinpal|supportsAutomaticRefund/i, owner: '#47 — the production rail' },
  { pattern: /credit_purchases|custom_purchase/, owner: '#99 — paid credit activation' },
  { pattern: /BookingCommercialTermsV1|BookingCommercialPolicySnapshotV1|CommercialPolicyRegistry/, owner: 'ADR-051 §2 — the superseded v1 contract, not reused' },
  { pattern: /emitEvent\(|OutboxEntity/, owner: 'no new outbox event (`V33-DEC-010` security decisions)' },
  { pattern: /@Controller\(|'bc_[a-z_]+'/, owner: 'no route and no capability' },
];

export const FORBIDDEN_COMMERCE_REACH: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /from '@beauclick\/(commercial-policy|payment|booking|financial)'/, why: 'another domain’s implementation package' },
  { pattern: /commercial\.|payment\.|booking\.(bookings|booking_history)/, why: 'another domain’s table' },
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

/** Every `auditLog.log({ ... })` / `logger.*(...)` call body in a source. */
export function logCalls(source: string): string[] {
  const cleaned = stripComments(source);
  return [...cleaned.matchAll(/(?:auditLog\.log|logger\.(?:log|warn|error|debug))\(([\s\S]*?)\);/g)].map((m) => m[1]);
}

const LEAKY_LOG = /toman|amount|legalCap|evidence|reference|reason|statement|workspaceRef|phone|customerId/i;

const read = (file: string): string => readFileSync(resolve(WORKSPACE_ROOT, file), 'utf8');
const sqlOf = (file: string): string => read(file).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('Story #160 (`#42c`) stays inside its outcome', () => {
  const created = CREATED_FILES.map((file) => ({ file, source: read(file) }));

  it('reads real files, so an empty finding list means something', () => {
    for (const { source } of created) expect(source.length).toBeGreaterThan(400);
    expect(read(MIGRATION)).toContain('uq_bod_one_live_per_kind');
  });

  it('contains nothing owned by #162, #43, #47 or #99, no new outbox event, no route or capability, and no v1 contract', () => {
    expect(created.flatMap(({ file, source }) => findConstructs(file, source))).toEqual([]);
  });

  it('keeps Commerce inside its scope: no other domain’s package or table', () => {
    expect(findCommerceReach(DECISION_SERVICE, read(DECISION_SERVICE))).toEqual([]);
    expect(findCommerceReach('services/commerce/src/ports.ts', read('services/commerce/src/ports.ts'))).toEqual([]);
  });

  it('keeps the evaluator pure: the contract is its only import, and no clock or connection appears', () => {
    const source = stripComments(read(EVALUATOR));
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['@beauclick/commercial-policy-contract']);
    expect(source).not.toMatch(/\bDate\b|now\(|Math\.random|EntityManager|DataSource|process\.env|\bNumber\(collected/);
  });

  it('puts no amount, cap, evidence, reason or identity into any log or audit line it writes', () => {
    const calls = [ORCHESTRATOR, DECISION_SERVICE, EVIDENCE_STATE].flatMap((file) => logCalls(read(file)));
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.filter((call) => LEAKY_LOG.test(call))).toEqual([]);
  });

  it('seeds nothing, alters nothing, creates exactly one table and puts DEFAULTs only on the database clock', () => {
    const sql = sqlOf(MIGRATION);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|TRIGGER|CONSTRAINT|COLUMN|INDEX)/i);
    expect(sql).not.toMatch(/\bUPDATE\s+(commerce|commercial|booking|payment)\./i);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    const defaults = [...sql.matchAll(/^\s*([a-z_]+)\s+[A-Z[\]()0-9]+.*\bDEFAULT\s+([^,\n]+)/gim)].map((m) => `${m[1]}=${m[2].trim()}`);
    expect(defaults).toEqual(['decided_at=now()']);
    // It reads only its own schema; the booking and Legal-evidence facts cross through ports.
    expect(sql).not.toMatch(/\b(booking|commercial|payment)\./);
  });

  it('makes both new seams mandatory and binds each exactly once', () => {
    const booking = stripComments(read('services/booking/src/booking/booking.service.ts'));
    expect(booking).toMatch(/@Inject\(BOOKING_RESCHEDULE_OUTCOME_HOOK\)\s*private readonly rescheduleOutcome/);
    expect(booking).not.toMatch(/@Optional\(\)\s*@Inject\(BOOKING_RESCHEDULE_OUTCOME_HOOK\)/);
    const decisions = stripComments(read(DECISION_SERVICE));
    expect(decisions).toMatch(/@Inject\(LEGAL_EVIDENCE_STATE_READER\) private readonly legalEvidence/);
    expect(decisions).not.toMatch(/@Optional\(\)/);

    const ports = stripComments(read('apps/api/src/composition/domain-ports.module.ts'));
    expect(ports.match(/provide: LEGAL_EVIDENCE_STATE_READER/g) ?? []).toHaveLength(1);
    const composition = stripComments(read(COMPOSITION));
    expect(composition.match(/provide: BOOKING_RESCHEDULE_OUTCOME_HOOK/g) ?? []).toHaveLength(1);
  });

  it('reaches the Legal-evidence plane only through the read-only state service, never #42a’s writer', () => {
    for (const file of [EVIDENCE_STATE, ORCHESTRATOR, DECISION_SERVICE, 'apps/api/src/composition/port-adapters.ts']) {
      expect(stripComments(read(file))).not.toMatch(/\bLegalEvidenceService\b|LegalEvidenceRecordEntity/);
    }
    expect(stripComments(read(EVIDENCE_STATE))).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it('keeps the BookingConfig reschedule guards, which still have consumers', () => {
    const config = read('services/booking/src/booking.config.ts');
    expect(config).toMatch(/get maxReschedulesPerBooking\(\)/);
    expect(config).toMatch(/get rescheduleMinHoursBefore\(\)/);
    expect(stripComments(read('services/booking/src/booking/booking.service.ts'))).toMatch(/this\.config\.maxReschedulesPerBooking/);
  });

  describe('the detectors are not vacuous', () => {
    it.each([
      ['a dispute', 'class DisputeCase {}'],
      ['a ledger write', 'await this.ledger.recordPayment({});'],
      ['a provider', 'const p: PaymentProvider = x;'],
      ['an outbox event', 'await emitEvent(m, CommerceOutboxEntity, {});'],
      ['a route', "@Controller('v1')"],
      ['the superseded contract', 'const t: BookingCommercialTermsV1 = {};'],
    ])('finds %s when it is planted', (_label, planted) => {
      expect(findConstructs('planted.ts', planted)).not.toEqual([]);
    });

    it('finds Commerce reaching another domain when it is planted', () => {
      expect(findCommerceReach('planted.ts', "import { X } from '@beauclick/payment';")).not.toEqual([]);
      expect(findCommerceReach('planted.ts', "await m.query('SELECT 1 FROM commercial.legal_evidence_records');")).not.toEqual([]);
    });

    it('finds a leaky log line when it is planted', () => {
      const planted = "this.auditLog.log({ action: 'x', refundToman: decision.refundToman });";
      expect(logCalls(planted).filter((call) => LEAKY_LOG.test(call))).not.toEqual([]);
    });

    it('does NOT fire on the same words inside a comment', () => {
      const documented = `
        // #162 owns dispute.cases; #43 owns settlement.
        /* emitEvent is deliberately absent. */
        const ok = 1;
      `;
      expect(findConstructs('documented.ts', documented)).toEqual([]);
    });
  });
});
