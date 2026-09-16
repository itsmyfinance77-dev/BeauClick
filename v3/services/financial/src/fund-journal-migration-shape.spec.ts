import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A static proof that `#43a`'s migration is PURELY ADDITIVE -- it never
 * touches `financial.ledger_entries`, `financial.settlement_batches` or
 * `financial.settlement_items` (ADR-052 §16's byte-identity requirement).
 *
 * ## Why this, and not only a row-hash test
 *
 * `financial-integrity.pg-spec.ts`'s legacy-fixture tests and
 * `fund-journal.pg-spec.ts`'s re-migrate/re-hash test prove byte-identity
 * DYNAMICALLY, against rows that exist at test time. This file proves the
 * STRUCTURAL guarantee underneath that: the migration's own SQL contains no
 * `ALTER`, `UPDATE`, `DELETE`, `TRUNCATE` or `INSERT` statement naming any of
 * the three legacy tables, so no row that existed before this migration ran
 * could have been touched by it, whatever data happens to be present. Two
 * independent proofs of the same property, from two different angles.
 */
/**
 * Splits on top-level `;` ONLY -- a `$$ ... $$` dollar-quoted PL/pgSQL
 * function body carries its own internal semicolons (`RAISE EXCEPTION ...;
 * END;`), and a naive split would shred one `CREATE FUNCTION` statement into
 * several fragments, most of which do not start with `CREATE`. Comments are
 * stripped first so a `;` inside one is never mistaken for a boundary either.
 */
function splitTopLevelStatements(source: string): string[] {
  const noComments = source.replace(/--[^\n]*/g, '');
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  for (let i = 0; i < noComments.length; i++) {
    if (noComments.startsWith('$$', i)) {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i += 1;
      continue;
    }
    if (noComments[i] === ';' && !inDollarQuote) {
      statements.push(current.trim());
      current = '';
      continue;
    }
    current += noComments[i];
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements.filter((s) => s.length > 0);
}

describe('the #43a migration never touches a legacy financial table', () => {
  const migrationPath = resolve(
    __dirname,
    '../../../database/migrations/financial/20260921100001_create_fund_journals_and_postings.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('reads the real migration file, so an empty finding list means something', () => {
    expect(sql.length).toBeGreaterThan(500);
    expect(sql).toContain('CREATE TABLE financial.fund_journals');
    expect(sql).toContain('CREATE TABLE financial.fund_postings');
  });

  const LEGACY_TABLES = ['ledger_entries', 'settlement_batches', 'settlement_items'];
  const MUTATING_VERBS = ['ALTER', 'UPDATE', 'DELETE', 'TRUNCATE', 'INSERT', 'DROP'];

  it('contains no mutating statement naming a legacy table', () => {
    // Strip `--` line comments and string literals first, so a docblock or a
    // quoted message mentioning a legacy table's name (this file's own
    // header does) is not mistaken for a statement touching it.
    const cleaned = sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");

    const findings: string[] = [];
    for (const verb of MUTATING_VERBS) {
      const pattern = new RegExp(`\\b${verb}\\b[^;]*\\b(${LEGACY_TABLES.join('|')})\\b`, 'gi');
      for (const match of cleaned.matchAll(pattern)) findings.push(match[0].trim().slice(0, 80));
    }
    expect(findings).toEqual([]);
  });

  it('only CREATEs new objects -- every top-level statement starts with CREATE (or is a comment)', () => {
    const statements = splitTopLevelStatements(sql);
    const nonCreate = statements.filter((s) => !/^CREATE\b/i.test(s));
    expect(nonCreate).toEqual([]);
  });

  it('is non-vacuous: a planted ALTER on a legacy table IS caught', () => {
    const planted = sql + '\nALTER TABLE financial.ledger_entries ADD COLUMN evil BOOLEAN;\n';
    const cleaned = planted.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
    const pattern = /\bALTER\b[^;]*\b(ledger_entries|settlement_batches|settlement_items)\b/gi;
    expect([...cleaned.matchAll(pattern)]).not.toEqual([]);
  });
});
