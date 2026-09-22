import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOKING_COLLECTION_DEPOSIT_KINDS,
  BOOKING_COLLECTION_MODES,
  BOOKING_COLLECTION_PERCENTAGE_BASES,
  BOOKING_OUTCOME_RETENTION_KINDS,
  CATALOGUE_LIFECYCLE_STATES,
  LEGAL_EVIDENCE_REFERENCE_KINDS,
  LEGAL_EVIDENCE_STATUSES,
  LEGAL_EVIDENCE_SUBJECTS,
  PRICE_SCHEDULE_PURPOSES,
} from '@beauclick/commercial-policy-contract';
import {
  COLLECTION_MODE_LABEL,
  DEPOSIT_KIND_LABEL,
  DERIVED_LABEL,
  EVIDENCE_REFERENCE_KIND_LABEL,
  EVIDENCE_STATUS_LABEL,
  EVIDENCE_SUBJECT_LABEL,
  KILL_SWITCH_LABEL,
  LIFECYCLE_LABEL,
  PERCENTAGE_BASE_LABEL,
  RETENTION_KIND_LABEL,
  ROLLOUT_STATE_LABEL,
  SCHEDULE_PURPOSE_LABEL,
  UNKNOWN_LABEL,
  collectionModeLabel,
  evidenceReferenceKindLabel,
  evidenceStatusView,
  evidenceSubjectLabel,
  killSwitchLabel,
  lifecycleView,
  rolloutStateLabel,
  schedulePurposeLabel,
} from '@/lib/commercial-labels';

/**
 * The admin commercial label tables against the lists they name (#239).
 *
 * The contract's vocabularies are imported and compared directly; the
 * enforcement states live in the SERVICE, which the web app does not import,
 * so those are read from its source.
 */

const V3 = join(__dirname, '../../..');

function serviceList(file: string, name: string): string[] {
  const source = readFileSync(join(V3, file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

const sorted = (values: readonly string[]) => [...values].sort();

describe.each([
  ['lifecycle states', LIFECYCLE_LABEL, CATALOGUE_LIFECYCLE_STATES],
  ['price schedule purposes', SCHEDULE_PURPOSE_LABEL, PRICE_SCHEDULE_PURPOSES],
  ['collection modes', COLLECTION_MODE_LABEL, BOOKING_COLLECTION_MODES],
  ['deposit kinds', DEPOSIT_KIND_LABEL, BOOKING_COLLECTION_DEPOSIT_KINDS],
  ['percentage bases', PERCENTAGE_BASE_LABEL, BOOKING_COLLECTION_PERCENTAGE_BASES],
  ['retention kinds', RETENTION_KIND_LABEL, BOOKING_OUTCOME_RETENTION_KINDS],
  ['evidence subjects', EVIDENCE_SUBJECT_LABEL, LEGAL_EVIDENCE_SUBJECTS],
  ['evidence reference kinds', EVIDENCE_REFERENCE_KIND_LABEL, LEGAL_EVIDENCE_REFERENCE_KINDS],
  ['evidence statuses', EVIDENCE_STATUS_LABEL, LEGAL_EVIDENCE_STATUSES],
])('%s', (_name, table, contract) => {
  it('name exactly the contract’s values', () => {
    expect(contract.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(table).sort()).toEqual(sorted(contract));
  });
});

describe('enforcement states (service source)', () => {
  const ENTITIES = 'services/commercial-policy/src/enforcement/booking-credit-enforcement.entities.ts';

  it('name exactly the rollout states', () => {
    expect(Object.keys(ROLLOUT_STATE_LABEL).sort()).toEqual(serviceList(ENTITIES, 'ENFORCEMENT_ROLLOUT_STATES'));
  });

  it('name exactly the kill-switch states', () => {
    expect(Object.keys(KILL_SWITCH_LABEL).sort()).toEqual(serviceList(ENTITIES, 'KILL_SWITCH_STATES'));
  });
});

describe('lifecycle is text and shape, never colour alone', () => {
  it('gives every stored and derived state its own glyph', () => {
    const glyphs = [...Object.values(LIFECYCLE_LABEL), ...Object.values(DERIVED_LABEL)].map((v) => v.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe('an unknown value is shown as "unknown", never as its key', () => {
  it.each([
    ['lifecycle', lifecycleView('archived').label],
    ['schedule purpose', schedulePurposeLabel('gift_card')],
    ['collection mode', collectionModeLabel('cash_on_delivery')],
    ['evidence subject', evidenceSubjectLabel('tax_ruling')],
    ['evidence reference kind', evidenceReferenceKindLabel('email')],
    ['evidence status', evidenceStatusView('voided').label],
    ['rollout state', rolloutStateLabel('paused')],
    ['kill switch', killSwitchLabel('tripped')],
  ])('%s', (_name, label) => {
    expect(label).toBe(UNKNOWN_LABEL);
  });
});
