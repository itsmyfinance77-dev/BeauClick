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

function enforcementSources(): Array<{ file: string; source: string }> {
  return readdirSync(ENFORCEMENT_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({ file: name, source: readFileSync(join(ENFORCEMENT_DIR, name), 'utf8') }));
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
});
