#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const POINT_VALUES = new Set([1, 2, 3, 5, 8, 13, 21]);
const DASHBOARD_TITLE = 'Backlog Dashboard';
const HISTORY_PATTERN = /<!-- backlog-history:(.*?) -->/s;

export function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
}

export function pointValue(issue) {
  const matches = labelsOf(issue)
    .filter((label) => /^sp:\d+$/.test(label))
    .map((label) => Number(label.slice(3)))
    .filter((value) => POINT_VALUES.has(value));
  return matches.length === 1 ? matches[0] : null;
}

function hasLabel(issue, name) {
  return labelsOf(issue).includes(name);
}

function statusOf(issue) {
  return labelsOf(issue).find((label) => label.startsWith('status:')) ?? 'status:missing';
}

export function dataWarnings(issues) {
  const warnings = [];
  const pointableTypes = new Set(['type:story', 'type:bug', 'type:decision', 'type:blocker']);
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = labelsOf(issue);
    const types = labels.filter((label) => label.startsWith('type:'));
    const priorities = labels.filter((label) => label.startsWith('priority:'));
    const statuses = labels.filter((label) => label.startsWith('status:'));
    const pointLabels = labels.filter((label) => label.startsWith('sp:'));
    const isMeta = labels.includes('type:meta');
    const isEpic = labels.includes('type:epic');
    const isPointable = types.some((type) => pointableTypes.has(type));

    if (types.length !== 1) warnings.push(`#${issue.number} must have exactly one type:* label.`);
    if (priorities.length !== 1) warnings.push(`#${issue.number} must have exactly one priority:* label.`);
    if (issue.state === 'open' && statuses.length !== 1) warnings.push(`#${issue.number} must have exactly one status:* label while open.`);
    if (issue.state === 'closed' && statuses.length > 0) warnings.push(`#${issue.number} is closed but still carries a status:* label.`);
    if (!isMeta && !issue.milestone) warnings.push(`#${issue.number} is a delivery item without a milestone.`);
    if (pointLabels.length > 1) warnings.push(`#${issue.number} has more than one story-point label.`);
    if (isEpic && pointLabels.length > 0) warnings.push(`#${issue.number} is an epic and must not carry Story Points.`);
    if (issue.state === 'open' && isPointable && pointValue(issue) === null) warnings.push(`#${issue.number} is open and unestimated.`);
    if (labels.includes('sp:21') && ['status:ready', 'status:in-progress', 'status:review'].includes(statusOf(issue))) {
      warnings.push(`#${issue.number} carries sp:21 and must be split before delivery.`);
    }
  }
  return warnings;
}

export function summarize(issues) {
  const pointed = issues.filter((issue) => pointValue(issue) !== null);
  const points = (items) => items.reduce((sum, issue) => sum + (pointValue(issue) ?? 0), 0);
  const open = issues.filter((issue) => issue.state === 'open');
  const actionable = open.filter((issue) => !hasLabel(issue, 'type:epic') && !hasLabel(issue, 'type:meta'));
  const total = points(pointed);
  const done = points(pointed.filter((issue) => issue.state === 'closed'));

  return {
    issues: issues.length,
    total,
    done,
    proposed: points(open.filter((issue) => statusOf(issue) === 'status:proposed')),
    decision: points(open.filter((issue) => statusOf(issue) === 'status:decision')),
    ready: points(open.filter((issue) => statusOf(issue) === 'status:ready')),
    active: points(open.filter((issue) => statusOf(issue) === 'status:in-progress')),
    review: points(open.filter((issue) => statusOf(issue) === 'status:review')),
    blocked: points(open.filter((issue) => statusOf(issue) === 'status:blocked')),
    unestimated: actionable.filter((issue) => pointValue(issue) === null).length,
    invalidPoints: issues.filter((issue) => labelsOf(issue).filter((label) => label.startsWith('sp:')).length > 1).length,
    percent: total === 0 ? null : Math.round((done / total) * 100),
  };
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function parseHistory(body) {
  const match = body?.match(HISTORY_PATTERN);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function updateHistory(history, milestoneSummaries, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const snapshot = {
    date,
    milestones: Object.fromEntries(
      [...milestoneSummaries.entries()].map(([name, summary]) => [name, {
        done: summary.done,
        total: summary.total,
        blocked: summary.blocked,
      }]),
    ),
  };
  const withoutToday = history.filter((item) => item?.date !== date);
  return [...withoutToday, snapshot].slice(-180);
}

function recentVelocity(issues, now = new Date()) {
  const weeks = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() - (offset * 7));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 7);
    const done = issues
      .filter((issue) => issue.state === 'closed' && issue.closed_at)
      .filter((issue) => {
        const closed = new Date(issue.closed_at);
        return closed > start && closed <= end;
      })
      .reduce((sum, issue) => sum + (pointValue(issue) ?? 0), 0);
    weeks.push({ ending: end.toISOString().slice(0, 10), done });
  }
  return weeks;
}

export function renderReport(issues, history = [], now = new Date()) {
  const groups = new Map();
  for (const issue of issues) {
    if (issue.pull_request || hasLabel(issue, 'type:meta')) continue;
    const milestone = issue.milestone?.title ?? 'Unscheduled';
    if (!groups.has(milestone)) groups.set(milestone, []);
    groups.get(milestone).push(issue);
  }

  const summaries = new Map([...groups.entries()].map(([name, items]) => [name, summarize(items)]));
  const nextHistory = updateHistory(history, summaries, now);
  const lines = [
    '# BeauClick Backlog Dashboard',
    '',
    `Generated from GitHub Issues at ${now.toISOString()}.`,
    '',
    '> Story points measure relative scope and uncertainty, not hours or individual productivity.',
    '',
    '## Milestone burn-up',
    '',
    '| Milestone | Done | Scope | Progress | Proposed | Decision | Ready | Active | Review | Blocked | Unestimated |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];

  for (const [name, summary] of [...summaries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${escapeCell(name)} | ${summary.done} | ${summary.total} | ${summary.percent === null ? '—' : `${summary.percent}%`} | ${summary.proposed} | ${summary.decision} | ${summary.ready} | ${summary.active} | ${summary.review} | ${summary.blocked} | ${summary.unestimated} |`);
  }

  const activeMilestone = [...summaries.entries()]
    .filter(([, summary]) => summary.total > summary.done)
    .sort(([a], [b]) => a.localeCompare(b))[0]?.[0];
  if (activeMilestone) {
    lines.push('', `## Recent burn-up — ${escapeCell(activeMilestone)}`, '', '| Date | Done points | Scope points | Blocked points |', '|---|---:|---:|---:|');
    for (const snapshot of nextHistory.slice(-10)) {
      const item = snapshot.milestones?.[activeMilestone];
      if (item) lines.push(`| ${snapshot.date} | ${item.done} | ${item.total} | ${item.blocked} |`);
    }
  }

  lines.push('', '## Recent completed-point trend', '', '| Seven-day window ending | Points closed |', '|---|---:|');
  for (const week of recentVelocity(issues, now)) lines.push(`| ${week.ending} | ${week.done} |`);

  const warnings = dataWarnings(issues);
  lines.push('', '## Data-quality warnings', '');
  if (warnings.length === 0) {
    lines.push('- None.');
  } else {
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  lines.push('', '<!-- This section is maintained automatically. Do not edit the history payload by hand. -->');
  lines.push(`<!-- backlog-history:${JSON.stringify(nextHistory)} -->`);
  return { markdown: `${lines.join('\n')}\n`, history: nextHistory, summaries };
}

async function api(path, options = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required.');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function allIssues(repo) {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`/repos/${repo}/issues?state=all&per_page=100&page=${page}`);
    issues.push(...batch);
    if (batch.length < 100) return issues;
  }
}

async function main() {
  const repoArg = process.argv.find((arg) => arg.startsWith('--repo='))?.slice('--repo='.length);
  const repo = repoArg || process.env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) throw new Error('Set GITHUB_REPOSITORY or pass --repo=owner/name.');

  const updateDashboard = process.argv.includes('--update-dashboard');
  const issues = await allIssues(repo);
  let dashboard = issues.find((issue) => !issue.pull_request && issue.state === 'open' && issue.title === DASHBOARD_TITLE && hasLabel(issue, 'type:meta'));
  const history = parseHistory(dashboard?.body ?? '');
  const report = renderReport(issues, history);

  process.stdout.write(report.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report.markdown);
  }

  if (updateDashboard) {
    if (!dashboard) throw new Error(`Open issue '${DASHBOARD_TITLE}' with label type:meta was not found.`);
    dashboard = await api(`/repos/${repo}/issues/${dashboard.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: report.markdown }),
    });
    process.stderr.write(`Updated dashboard issue #${dashboard.number}.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
