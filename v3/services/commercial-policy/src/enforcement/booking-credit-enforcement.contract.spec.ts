import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import {
  BookingCreditEnforcementControlEntity,
  BookingCreditPartyGovernanceEntity,
  ENFORCEMENT_CONTROL_SINGLETON_ID,
  ENFORCEMENT_ROLLOUT_STATES,
  KILL_SWITCH_STATES,
  PARTY_GOVERNANCE_CAUSES,
  PARTY_GOVERNANCE_STATES,
} from './booking-credit-enforcement.entities';
import {
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE,
  ELIGIBLE_PARTIES_SQL,
  ENFORCEMENT_AUDIT_ACTIONS,
} from './booking-credit-enforcement.constants';

/** `bcre`, spelled here rather than imported: the ledger service pulls in the events lib the fast config does not map. */
const BOOKING_ENTITLEMENT_LOCK_NAMESPACE = 0x62_63_72_65 | 0;

/**
 * V3.3 Stories #95 (`#58b-1`) and #141 (`#58b-2`) -- the closed contract,
 * pinned (ADR-050 §10 cases 24, 29, 30 and the story boundaries).
 *
 * The constraint, trigger, lock and transactional behaviour lives in
 * `apps/api/test/booking-credit-enforcement.pg-spec.ts` and
 * `booking-credit-activation.pg-spec.ts` -- it needs a real server. This file
 * checks the shapes a real server cannot: the vocabularies, the entity
 * columns, that the migration confers nothing, and the STRUCTURAL facts #141
 * turned from absences into exactly-once presences: ONE site assigns
 * `rollout_state = 'active'` (activation), ONE site writes
 * `created_under_enforcement` (the creation hook), ONE site takes `bcgv`
 * exclusively (activation), ONE activation route, and no environment read
 * anywhere.
 */
const WORKSPACE_ROOT = resolve(__dirname, '../../../..');
const ENFORCEMENT_DIR = __dirname;
const MIGRATION = join(
  WORKSPACE_ROOT,
  'database/migrations/commercial/20260917100001_create_booking_credit_enforcement_controls.sql',
);

/** Comments stripped: the boundary scans below are about STATEMENTS, and the docblocks legitimately name what the story does not do. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function enforcementSources(): Array<{ file: string; source: string }> {
  return readdirSync(ENFORCEMENT_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({ file: name, source: stripComments(readFileSync(join(ENFORCEMENT_DIR, name), 'utf8')) }));
}

describe('booking-credit enforcement control contract (#95 / #58b-1)', () => {
  describe('the vocabularies', () => {
    it('rollout is EXACTLY inactive | active', () => {
      expect([...ENFORCEMENT_ROLLOUT_STATES]).toEqual(['inactive', 'active']);
    });

    it('kill switch is EXACTLY released | engaged', () => {
      expect([...KILL_SWITCH_STATES]).toEqual(['released', 'engaged']);
    });

    it('governance state is EXACTLY legacy_exempt | governed -- no third state, no "unresolved" member', () => {
      expect([...PARTY_GOVERNANCE_STATES]).toEqual(['legacy_exempt', 'governed']);
    });

    it('cause is the closed three, one of which is reserved for #141', () => {
      expect([...PARTY_GOVERNANCE_CAUSES]).toEqual(['explicit_transition', 'explicit_exemption', 'created_under_enforcement']);
    });

    it('the singleton id is 1 -- a fixed identity, not a configurable one', () => {
      expect(ENFORCEMENT_CONTROL_SINGLETON_ID).toBe(1);
    });
  });

  describe('the entities', () => {
    it('the control row declares exactly the ADR-050 §2.1 columns and NO actor column', () => {
      const columns = getMetadataArgsStorage()
        .filterColumns(BookingCreditEnforcementControlEntity)
        .map((c) => c.propertyName)
        .sort();
      expect(columns).toEqual(
        [
          'id',
          'rolloutState',
          'activationGeneration',
          'activatedAt',
          'activationAuditId',
          'killSwitchState',
          'killSwitchChangedAt',
          'killSwitchAuditId',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      for (const forbidden of ['activatedByUserId', 'actorUserId', 'engagedByUserId', 'allowance', 'quantity', 'price']) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('the governance row declares exactly the ADR-050 §2.2 columns', () => {
      const columns = getMetadataArgsStorage()
        .filterColumns(BookingCreditPartyGovernanceEntity)
        .map((c) => c.propertyName)
        .sort();
      expect(columns).toEqual(
        [
          'id',
          'partyType',
          'partyId',
          'state',
          'cause',
          'proofGrantId',
          'recordedAt',
          'governedAt',
          'recordedByUserId',
          'recordedByLabel',
          'auditId',
        ].sort(),
      );
    });

    it('both map to the commercial schema under their ratified names', () => {
      const tables = getMetadataArgsStorage().tables;
      const control = tables.find((t) => t.target === BookingCreditEnforcementControlEntity);
      const governance = tables.find((t) => t.target === BookingCreditPartyGovernanceEntity);
      expect(control?.name).toBe('booking_credit_enforcement_control');
      expect(control?.schema).toBe('commercial');
      expect(governance?.name).toBe('booking_credit_party_governance');
      expect(governance?.schema).toBe('commercial');
    });
  });

  describe('the migration confers nothing (case 24)', () => {
    const sql = readFileSync(MIGRATION, 'utf8');

    it('exists at the next commercial timestamp', () => {
      expect(sql.length).toBeGreaterThan(1000);
    });

    it('seeds exactly one control row and no governance row', () => {
      const inserts = sql.match(/INSERT\s+INTO\s+commercial\.[a-z_]+/gi) ?? [];
      expect(inserts).toEqual(['INSERT INTO commercial.booking_credit_enforcement_control']);
      expect(sql).not.toMatch(/INSERT\s+INTO\s+commercial\.booking_credit_party_governance/i);
    });

    it('the only numbers the seed writes are the singleton id and a zero generation', () => {
      const values = sql.match(/VALUES\s*\(([^)]*)\)/i)?.[1] ?? '';
      const numbers = [...values.matchAll(/(?<![A-Za-z0-9_'])(\d+)(?![A-Za-z0-9_'])/g)].map((m) => Number(m[1]));
      expect(numbers.sort()).toEqual([0, 1]);
    });

    it('seeds the initial SAFE state: inactive, released, generation zero', () => {
      expect(sql).toMatch(/\(1,\s*'inactive',\s*0,\s*'released'\)/);
    });

    it('declares no DEFAULT on any state or generation column that could confer a value', () => {
      const columnLines = sql
        .split(/\r?\n/)
        .filter((line) => /^\s+(rollout_state|activation_generation|kill_switch_state|state|cause|proof_grant_id)\s/.test(line));
      expect(columnLines.length).toBeGreaterThanOrEqual(6);
      for (const line of columnLines) expect(line.toLowerCase()).not.toContain('default');
    });

    it('names every consistency constraint ADR-050 §2 requires', () => {
      for (const name of [
        'ck_bcec_singleton',
        'ck_bcec_rollout_state',
        'ck_bcec_kill_switch_state',
        'ck_bcec_generation',
        'ck_bcec_activation_consistent',
        'ck_bcec_kill_switch_consistent',
        'uq_bcpg_party',
        'ck_bcpg_party_type',
        'ck_bcpg_state',
        'ck_bcpg_cause',
        'ck_bcpg_cause_state',
        'ck_bcpg_proof',
        'ck_bcpg_governed_at',
        'ck_bcpg_actor',
        'tg_bcec_protect',
        'tg_bcpg_protect',
        'ix_bcpg_state',
      ]) {
        expect(sql).toContain(name);
      }
    });

    it('puts no cross-schema foreign key on party_id, and a real one on proof_grant_id', () => {
      expect(sql).not.toMatch(/party_id\s+UUID\s+NOT\s+NULL\s+REFERENCES/i);
      expect(sql).toMatch(/proof_grant_id\s+UUID\s+REFERENCES\s+commercial\.booking_credit_grants\s*\(id\)/i);
      expect(sql).not.toMatch(/REFERENCES\s+(provider|business|admin|identity)\./i);
    });
  });

  describe('the story boundary: what #141 (`#58b-2`) owns, exactly once each', () => {
    const sources = enforcementSources();
    const governance = () => sources.find((s) => s.file === 'booking-credit-enforcement-governance.service.ts')!.source;

    it('has enforcement sources to assert against', () => {
      expect(sources.length).toBeGreaterThanOrEqual(1);
    });

    it("EXACTLY ONE statement assigns rollout_state = 'active' -- activation's UPDATE, in the governance service", () => {
      const sites: string[] = [];
      for (const { file, source } of sources) {
        // Comparisons (`=== 'active'`) and audit snapshots (`after: { rolloutState: 'active' }`)
        // are not writes; a SQL `SET rollout_state = 'active'` or a query-builder `.set({ rolloutState` is.
        for (const m of source.matchAll(/SET rollout_state = 'active'|\.set\(\{[^}]*rolloutState/g)) sites.push(`${file}:${m[0]}`);
        expect({ file, hit: /update\(BookingCreditEnforcementControlEntity\)/.test(source) }).toEqual({ file, hit: false });
      }
      expect(sites).toEqual(["booking-credit-enforcement-governance.service.ts:SET rollout_state = 'active'"]);
      // And the UPDATE that carries it moves every activation fact together.
      expect(governance()).toMatch(/SET rollout_state = 'active',\s*activation_generation = activation_generation \+ 1,\s*activated_at = now\(\),\s*activation_audit_id = \$2/);
    });

    it("EXACTLY ONE statement writes cause 'created_under_enforcement' -- the creation hook", () => {
      const sites: string[] = [];
      for (const { file, source } of sources) {
        // Row writes only: an INSERT of the governance entity, or a query-builder UPDATE `.set({ ... })`.
        for (const m of source.matchAll(/insert\(BookingCreditPartyGovernanceEntity, \{[^}]*\}|\.set\(\{[^}]*\}/g)) {
          if (m[0].includes("cause: 'created_under_enforcement'")) sites.push(`${file}:${m[0].slice(0, 44)}`);
        }
      }
      expect(sites).toEqual(['booking-credit-enforcement-governance.service.ts:insert(BookingCreditPartyGovernanceEntity, {']);
      // With no grant, no proof, and the system label -- never a user id.
      expect(governance()).toMatch(/cause: 'created_under_enforcement',\s*proofGrantId: null,\s*governedAt: new Date\(\),\s*recordedByUserId: null,\s*recordedByLabel: SYSTEM_ACTOR_LABEL/);
    });

    it('activation writes no governance row, no grant, no subscription: it touches the singleton and the audit log only', () => {
      const src = governance();
      const activate = src.slice(src.indexOf('async activate('), src.indexOf('async initializeCreatedParty('));
      expect(activate).toContain('takeCoordinationExclusive(manager)');
      expect(activate).toContain('FOR UPDATE');
      // The partition is taken from the shared function AS IS -- not spread, wrapped, filtered or recomputed.
      expect(activate).toContain('const partition = await this.partition(manager);');
      expect(activate).not.toMatch(/partition\s*=\s*\{/);
      expect(activate).toContain('CommercialEnforcementActivationRefusedException');
      expect(activate).toMatch(/UPDATE commercial\.booking_credit_enforcement_control/);
      expect(activate).not.toMatch(/INSERT|BookingCreditPartyGovernanceEntity|booking_credit_grants|seller_subscriptions|kill_switch/);
    });

    it('the creation hook takes bcgv SHARED, reads the control row FOR SHARE, and writes nothing under an inactive rollout', () => {
      const src = governance();
      const hook = src.slice(src.indexOf('async initializeCreatedParty('), src.indexOf('// Kill switch (ADR-050'));
      expect(hook.indexOf('takeCoordinationShared')).toBeGreaterThan(-1);
      expect(hook.indexOf('readForConfirmation')).toBeGreaterThan(hook.indexOf('takeCoordinationShared'));
      expect(hook).toMatch(/if \(control\.rolloutState !== 'active'\) return;/);
      expect(hook.indexOf('recordSystem')).toBeGreaterThan(hook.indexOf("!== 'active') return;"));
      expect(hook.indexOf('manager.insert(BookingCreditPartyGovernanceEntity')).toBeGreaterThan(hook.indexOf('recordSystem'));
      expect(hook).not.toMatch(/booking_credit_grants|BookingCreditGrantEntity|quantity/);
    });

    it('reads no environment variable: the planes are rows, never flags', () => {
      for (const { file, source } of sources) {
        expect({ file, hit: /process\.env|ConfigService/.test(source) }).toEqual({ file, hit: false });
      }
    });

    it('the four-plane seam under an active rollout is decided in the control service, not by reordering the pure gate', () => {
      const control = sources.find((s) => s.file === 'booking-credit-enforcement-control.service.ts')!.source;
      expect(control).toContain('decideGovernance(');
      expect(control).toContain('decideGovernedLedger(');
      expect(control).toContain('readGovernanceForConfirmation(');
      // The unresolved refusal is NOT produced by the gate (which would say entitlement_missing).
      const decideGovernance = control.slice(control.indexOf('decideGovernance('), control.indexOf('decideGovernedLedger('));
      expect(decideGovernance).not.toContain('this.gate.decide');
      expect(decideGovernance).toContain("reason: 'business_policy_disabled'");
      // The governed verdict IS the gate, with every plane evaluated.
      const governed = control.slice(control.indexOf('decideGovernedLedger('));
      expect(governed).toMatch(/killSwitchActive: false,\s*rolloutEnabled: true,\s*entitlementGranted: ledger === 'consumed' \|\| ledger === 'already_consumed',\s*businessPolicyEnabled: true/);
      // The gate itself is byte-for-byte the #39 evaluator: kill -> rollout -> entitlement -> business policy.
      const gate = stripComments(readFileSync(join(ENFORCEMENT_DIR, '..', 'commercial-policy-control.gate.ts'), 'utf8'));
      const order = ['killSwitchActive', 'rolloutEnabled', 'entitlementGranted', 'businessPolicyEnabled'].map((k) => gate.indexOf(`controls.${k}`));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('the governance read takes the SAME bcre party lock the ledger takes, spelled once', () => {
      const lock = sources.find((s) => s.file === 'booking-entitlement-party-lock.ts')!.source;
      expect(lock).toContain("SELECT pg_advisory_xact_lock($1, hashtext($2))");
      expect(lock).toContain('BOOKING_ENTITLEMENT_LOCK_NAMESPACE');
      expect(lock).toContain('`${party.partyType}:${party.partyId}`');
      // Nobody else in this directory spells the per-party lock.
      for (const { file, source } of sources) {
        if (file === 'booking-entitlement-party-lock.ts') continue;
        expect({ file, hit: /hashtext/.test(source) }).toEqual({ file, hit: false });
      }
      const control = sources.find((s) => s.file === 'booking-credit-enforcement-control.service.ts')!.source;
      const read = control.slice(control.indexOf('async readGovernanceForConfirmation('), control.indexOf('decideGovernance('));
      expect(read.indexOf('lockBookingEntitlementParty(manager, party)')).toBeLessThan(read.indexOf('findOne'));
    });
  });

  describe('the ONE eligibility predicate (ADR-050 §3.1, case 2)', () => {
    const sources = enforcementSources();

    it('is non-deleted professionals UNION ALL non-deleted businesses, and consults nothing else', () => {
      expect(ELIGIBLE_PARTIES_SQL).toMatch(/FROM provider\.professionals p\s+WHERE p\.deleted_at IS NULL/);
      expect(ELIGIBLE_PARTIES_SQL).toMatch(/FROM business\.businesses b\s+WHERE b\.deleted_at IS NULL/);
      expect(ELIGIBLE_PARTIES_SQL).toContain('UNION ALL');
      expect(ELIGIBLE_PARTIES_SQL).not.toMatch(/verification|business_staff|seller_subscriptions|owner_id/);
    });

    it('is defined at exactly ONE site and embedded wherever eligibility is read -- never re-spelled', () => {
      const definitions = sources.filter(({ source }) => /export const ELIGIBLE_PARTIES_SQL\s*=/.test(source));
      expect(definitions.map((d) => d.file)).toEqual(['booking-credit-enforcement.constants.ts']);
      // No second spelling of the ELIGIBILITY predicate anywhere in the module:
      // a scan of either party table by `deleted_at IS NULL`. (The subject-data
      // contract's OWNERSHIP query -- "which parties does this user own", by
      // `owner_id` -- answers a different question and is the precedent every
      // contract in this service follows; it is not a re-spelling.)
      for (const { file, source } of sources) {
        const respelled = source.split('export const ELIGIBLE_PARTIES_SQL')[1] ?? source;
        const hits =
          (respelled.match(/FROM provider\.professionals[^;`]*?deleted_at IS NULL/g) ?? []).length +
          (respelled.match(/FROM business\.businesses[^;`]*?deleted_at IS NULL/g) ?? []).length;
        expect({ file, hits }).toEqual({ file, hits: file === 'booking-credit-enforcement.constants.ts' ? 2 : 0 });
      }
      // Every place that needs eligibility embeds the constant.
      const governance = sources.find((s) => s.file === 'booking-credit-enforcement-governance.service.ts')!.source;
      expect((governance.match(/\$\{ELIGIBLE_PARTIES_SQL\}/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('the coordination lock namespace (ADR-050 §7.2, case 29)', () => {
    it("is 'bcgv', a distinct signed 32-bit namespace, never bcre", () => {
      expect(BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE).toBe(0x62_63_67_76 | 0);
      expect(BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE).not.toBe(BOOKING_ENTITLEMENT_LOCK_NAMESPACE);
      for (const other of [0x61_69_63_6e | 0, 0x62_6b_61_73 | 0, 0x73_72_72_71 | 0, 0x77_69_73_68 | 0]) {
        expect(BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE).not.toBe(other);
      }
    });

    it('is taken SHARED by transition, exemption and the creation hook, and EXCLUSIVELY at exactly one site: activation', () => {
      const governance = enforcementSources().find((s) => s.file === 'booking-credit-enforcement-governance.service.ts')!.source;
      expect(governance.match(/pg_advisory_xact_lock_shared\(\$1, \$2\)/g)).toHaveLength(1);
      expect(governance.match(/pg_advisory_xact_lock\(\$1, \$2\)/g)).toHaveLength(1);
      expect(governance.match(/takeCoordinationExclusive\(manager\)/g)).toHaveLength(1);
      const activate = governance.slice(governance.indexOf('async activate('), governance.indexOf('async initializeCreatedParty('));
      expect(activate).toContain('takeCoordinationExclusive(manager)');
      expect(activate).not.toContain('takeCoordinationShared');
      for (const { file, source } of enforcementSources()) {
        if (file === 'booking-credit-enforcement-governance.service.ts') continue;
        expect({ file, hit: /pg_advisory_xact_lock(_shared)?\(\$1, \$2\)/.test(source) }).toEqual({ file, hit: false });
      }
    });
  });

  describe('the administrator surface (ADR-050 §5.2)', () => {
    const controller = stripComments(readFileSync(join(ENFORCEMENT_DIR, 'booking-credit-enforcement.controller.ts'), 'utf8'));

    it('is mounted under the existing commercial admin namespace and class-gated on the privileged capability', () => {
      expect(controller).toContain("@Controller('v1/admin/commercial/booking-credit-enforcement')");
      expect(controller).toContain("@RequireCapability('bc_manage_commercial_plans')");
      expect(controller.indexOf('@RequireCapability')).toBeLessThan(controller.indexOf('export class'));
    });

    it('declares exactly the six #95 routes plus #141\'s activation -- and no activation/preview, no deactivation', () => {
      const routes = [...controller.matchAll(/@(Get|Post)\((?:'([^']*)')?\)/g)].map((m) => `${m[1]} ${m[2] ?? ''}`.trim());
      expect(routes).toEqual([
        'Get',
        'Get preview',
        'Post transitions',
        'Post exemptions',
        'Post kill-switch/engage',
        'Post kill-switch/release',
        'Post activation',
      ]);
      expect(controller).not.toMatch(/activation\/preview|deactivat|@Delete|@Patch|@Put/i);
    });

    it('every mutation carries an audit action from the closed vocabulary and takes exactly a ReasonDto', () => {
      const posts = controller.match(/@Post\([^)]*\)\s*@AuditAction\(ENFORCEMENT_AUDIT_ACTIONS\.[a-zA-Z]+\)/g) ?? [];
      expect(posts).toHaveLength(5);
      expect(controller).toMatch(/@Post\('activation'\)\s*@AuditAction\(ENFORCEMENT_AUDIT_ACTIONS\.activated\)/);
      expect(controller.match(/@Body\(\) dto: ReasonDto/g) ?? []).toHaveLength(5);
      expect(controller).not.toMatch(/@Body\(\) dto: (?!ReasonDto)/);
      // The only query parameter any handler declares is the EMPTY one, which refuses every parameter.
      expect(controller.match(/@Query\(\)[^,)]*/g)).toEqual(['@Query() _query: EmptyQueryDto']);
      expect(Object.values(ENFORCEMENT_AUDIT_ACTIONS).sort()).toEqual([
        'commercial.enforcement_activated',
        'commercial.enforcement_kill_switch_engaged',
        'commercial.enforcement_kill_switch_released',
        'commercial.enforcement_parties_exempted',
        'commercial.enforcement_parties_governed',
        'commercial.enforcement_party_governed_at_creation',
      ]);
    });

    it('the closed vocabulary is the ONLY source of an audit action: no string literal is passed to record()/recordSystem()', () => {
      const governance = enforcementSources().find((s) => s.file === 'booking-credit-enforcement-governance.service.ts')!.source;
      const values = [...governance.matchAll(/\baction:\s*([^,\n)]+)/g)].map((m) => m[1].trim());
      expect(values.length).toBeGreaterThanOrEqual(5);
      for (const value of values) {
        // A constant from the closed vocabulary, the kill switch's pass-through parameter, or that parameter's type.
        expect(value).toMatch(/^(ENFORCEMENT_AUDIT_ACTIONS\.[a-zA-Z]+|action|string)$/);
      }
      expect(governance).not.toMatch(/action:\s*['"`]/);
    });
  });
});
