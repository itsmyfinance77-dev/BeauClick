import test from 'node:test';
import assert from 'node:assert/strict';

import { dataWarnings, pointValue, renderReport, summarize } from './backlog-report.mjs';

function issue(number, state, labels, milestone = 'V3.2-C', closedAt = null) {
  return {
    number,
    state,
    labels: labels.map((name) => ({ name })),
    milestone: { title: milestone },
    closed_at: closedAt,
  };
}

test('accepts exactly one Fibonacci story-point label', () => {
  assert.equal(pointValue(issue(1, 'open', ['sp:5'])), 5);
  assert.equal(pointValue(issue(2, 'open', [])), null);
  assert.equal(pointValue(issue(3, 'open', ['sp:3', 'sp:5'])), null);
  assert.equal(pointValue(issue(4, 'open', ['sp:4'])), null);
});

test('calculates milestone burn-up without counting epics as unestimated work', () => {
  const summary = summarize([
    issue(1, 'closed', ['type:story', 'sp:5']),
    issue(2, 'open', ['type:story', 'status:in-progress', 'sp:8']),
    issue(3, 'open', ['type:story', 'status:blocked', 'sp:3']),
    issue(4, 'open', ['type:decision', 'status:decision']),
    issue(5, 'open', ['type:epic', 'status:proposed']),
  ]);
  assert.deepEqual(summary, {
    issues: 5,
    total: 16,
    done: 5,
    proposed: 0,
    decision: 0,
    ready: 0,
    active: 8,
    review: 0,
    blocked: 3,
    unestimated: 1,
    invalidPoints: 0,
    percent: 31,
  });
});

test('renders a dashboard with warnings and hidden burn-up history', () => {
  const now = new Date('2026-08-30T12:00:00.000Z');
  const report = renderReport([
    issue(1, 'closed', ['type:story', 'sp:5'], 'V3.2-C', '2026-08-29T10:00:00.000Z'),
    issue(2, 'open', ['type:story', 'status:ready', 'sp:8']),
    issue(3, 'open', ['type:decision', 'status:decision']),
  ], [], now);
  assert.match(report.markdown, /\| V3\.2-C \| 5 \| 13 \| 38% \| 0 \| 0 \| 8/);
  assert.match(report.markdown, /#3 is open and unestimated/);
  assert.match(report.markdown, /<!-- backlog-history:/);
});

test('reports classification errors without treating an unpointed epic as invalid', () => {
  const issues = [
    issue(1, 'open', ['type:epic', 'priority:p1', 'status:proposed']),
    issue(2, 'open', ['type:story', 'priority:p1', 'status:ready', 'sp:21']),
    { ...issue(3, 'closed', ['type:bug', 'priority:p2', 'status:review', 'sp:3']), closed_at: '2026-08-30T10:00:00.000Z' },
    { ...issue(4, 'open', ['type:decision', 'priority:p1', 'status:decision']), milestone: null },
  ];
  assert.deepEqual(dataWarnings(issues), [
    '#2 carries sp:21 and must be split before delivery.',
    '#3 is closed but still carries a status:* label.',
    '#4 is a delivery item without a milestone.',
    '#4 is open and unestimated.',
  ]);
});
