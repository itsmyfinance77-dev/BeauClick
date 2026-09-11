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
 * V3.3 Story #95 (`#58b-1`) -- the closed contract, pinned (ADR-050 §10
 * cases 24, 29, 30 and the story boundary).
 *
 * The constraint, trigger, lock and transactional behaviour lives in
 * `apps/api/test/booking-credit-enforcement.pg-spec.ts` -- it needs a real
 * server. This file checks the shapes a real server cannot: the vocabularies,
 * the entity columns, that the migration confers nothing, and -- the story
 * boundary -- that no #95 source writes `rollout_state = 'active'`, writes the
 * #141-reserved cause, or declares an activation route or a seller-creation
 * governance port.
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

  describe('the story boundary: #95 ships no #141 responsibility', () => {
    const sources = enforcementSources();

    it('has enforcement sources to assert against', () => {
      expect(sources.length).toBeGreaterThanOrEqual(1);
    });

    it('no #95 source writes rollout_state = active', () => {
      for (const { file, source } of sources) {
        // Type unions and vocabulary arrays may NAME the value; no statement may ASSIGN it.
        const assignments = source.match(/rolloutState\s*[:=]\s*'active'|rollout_state\s*=\s*'active'/g) ?? [];
        expect({ file, assignments }).toEqual({ file, assignments: [] });
      }
    });

    it('no #95 source writes the #141-reserved cause', () => {
      for (const { file, source } of sources) {
        const writes = source.match(/cause\s*[:=]\s*'created_under_enforcement'/g) ?? [];
        expect({ file, writes }).toEqual({ file, writes: [] });
      }
    });

    it('declares no activation route and no seller-creation governance port', () => {
      for (const { file, source } of sources) {
        expect({ file, hit: /@Post\(\s*['"]activation['"]\s*\)/.test(source) }).toEqual({ file, hit: false });
        expect({ file, hit: /SELLER_GOVERNANCE_INITIALIZATION|BUSINESS_GOVERNANCE_INITIALIZATION|initializeGovernanceFor/.test(source) }).toEqual({
          file,
          hit: false,
        });
      }
    });

    it('reads no environment variable: the planes are rows, never flags', () => {
      for (const { file, source } of sources) {
        expect({ file, hit: /process\.env|ConfigService/.test(source) }).toEqual({ file, hit: false });
      }
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

    it('is taken SHARED by this story and never exclusively', () => {
      const governance = enforcementSources().find((s) => s.file === 'booking-credit-enforcement-governance.service.ts')!.source;
      expect(governance).toContain('pg_advisory_xact_lock_shared($1, $2)');
      expect(governance).not.toMatch(/pg_advisory_xact_lock\(\$1, \$2\)/);
    });
  });

  describe('the administrator surface (ADR-050 §5.2)', () => {
    const controller = stripComments(readFileSync(join(ENFORCEMENT_DIR, 'booking-credit-enforcement.controller.ts'), 'utf8'));

    it('is mounted under the existing commercial admin namespace and class-gated on the privileged capability', () => {
      expect(controller).toContain("@Controller('v1/admin/commercial/booking-credit-enforcement')");
      expect(controller).toContain("@RequireCapability('bc_manage_commercial_plans')");
      expect(controller.indexOf('@RequireCapability')).toBeLessThan(controller.indexOf('export class'));
    });

    it('declares exactly the six #95 routes and NO activation route', () => {
      const routes = [...controller.matchAll(/@(Get|Post)\((?:'([^']*)')?\)/g)].map((m) => `${m[1]} ${m[2] ?? ''}`.trim());
      expect(routes).toEqual(['Get', 'Get preview', 'Post transitions', 'Post exemptions', 'Post kill-switch/engage', 'Post kill-switch/release']);
      expect(controller).not.toMatch(/activation/i);
    });

    it('every mutation carries an audit action from the closed vocabulary and takes exactly a ReasonDto', () => {
      const posts = controller.match(/@Post\([^)]*\)\s*@AuditAction\(ENFORCEMENT_AUDIT_ACTIONS\.[a-zA-Z]+\)/g) ?? [];
      expect(posts).toHaveLength(4);
      expect(controller.match(/@Body\(\) dto: ReasonDto/g) ?? []).toHaveLength(4);
      expect(controller).not.toMatch(/@Body\(\) dto: (?!ReasonDto)/);
      expect(Object.values(ENFORCEMENT_AUDIT_ACTIONS).sort()).toEqual([
        'commercial.enforcement_kill_switch_engaged',
        'commercial.enforcement_kill_switch_released',
        'commercial.enforcement_parties_exempted',
        'commercial.enforcement_parties_governed',
      ]);
    });
  });
});
