// Results of the browser flows, kept in four explicit kinds so a rendered page is never counted as
// an exercised feature:
//   ui       — an action taken in the browser (click/type) and its immediate on-screen effect
//   persist  — the effect survives a reload and/or is in the database (read-only query)
//   other    — the counterpart role sees it (e.g. the professional sees the customer's booking)
//   denied   — a role that must not do/see it is refused
import fs from 'node:fs';
import path from 'node:path';

export function recorder(outDir) {
  const rows = [];
  const write = () => fs.writeFileSync(path.join(outDir, 'flows.json'), JSON.stringify(rows, null, 2));
  const rec = (flow, kind, check, pass, detail = '') => {
    rows.push({ at: new Date().toISOString(), flow, kind, check, pass: Boolean(pass), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    console.log(`${pass ? 'PASS' : 'FAIL'} [${flow}] ${kind.padEnd(7)} ${check}${detail ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 160)})` : ''}`);
    write();
  };
  /** Runs one flow; an exception is recorded as a failed step and the next flow still runs. */
  const flow = async (name, fn) => {
    try {
      await fn((kind, check, pass, detail) => rec(name, kind, check, pass, detail));
    } catch (e) {
      rec(name, 'error', 'flow aborted', false, e instanceof Error ? e.message : String(e));
    }
  };
  return { rows, flow, write };
}
