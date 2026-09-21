import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_ACTION_LABEL,
  CHAT_REPORT_REASON_LABEL,
  CHAT_REPORT_STATUS_LABEL,
  CHAT_REPORT_UNAVAILABLE,
  CHAT_REPORT_UNREADABLE,
  UNKNOWN_ACTION_LABEL,
  chatActionLabel,
  chatReportReasonLabel,
  chatReportStatusView,
  MEDIA_REPORT_REASON_LABEL,
  PRIVACY_KIND_LABEL,
  PRIVACY_STATUS_LABEL,
  REVIEW_STATUS_LABEL,
  UNKNOWN_KIND_LABEL,
  UNKNOWN_REASON_LABEL,
  UNKNOWN_STATUS_LABEL,
  mediaReportReasonLabel,
  privacyKindLabel,
  privacyStatusView,
  reviewStatusView,
} from '@/lib/moderation-labels';

/**
 * The operator queues' label tables against the server lists they name (#238).
 *
 * Each list is read from the server's SOURCE rather than imported, because the
 * web app does not depend on the server packages — so an added or dropped value
 * is caught here rather than reaching an operator as an English key.
 */

const V3 = join(__dirname, '../../..');

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(file: string, name: string): string[] {
  const source = readFileSync(join(V3, file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('media report reasons', () => {
  const server = () => serverList('libs/media/src/entities/media-abuse-report.entity.ts', 'ABUSE_REPORT_REASONS');

  it('name exactly the reasons a report can carry', () => {
    expect(server().length).toBeGreaterThanOrEqual(4); // guards an empty parse
    expect(Object.keys(MEDIA_REPORT_REASON_LABEL).sort()).toEqual(server());
  });

  it('show a neutral word, never the raw key, for a reason they have never heard of', () => {
    expect(mediaReportReasonLabel('deepfake')).toBe(UNKNOWN_REASON_LABEL);
    expect(mediaReportReasonLabel('explicit')).toBe('محتوای نامناسب');
  });
});

describe('review statuses', () => {
  const server = () => serverList('services/provider/src/entities/review.entity.ts', 'REVIEW_STATUSES');

  it('name exactly the statuses a review can have', () => {
    expect(server().length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(REVIEW_STATUS_LABEL).sort()).toEqual(server());
  });

  it('show a neutral word for a status they have never heard of', () => {
    expect(reviewStatusView('quarantined')).toEqual({ label: UNKNOWN_STATUS_LABEL, tone: 'neutral' });
  });
});

describe('chat reports', () => {
  const CONTRACT = 'packages/chat-contract/src/chat-contract.ts';

  it('name exactly the reasons, statuses and upheld actions the chat contract declares', () => {
    const reasons = serverList(CONTRACT, 'CHAT_REPORT_REASONS');
    expect(reasons.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(CHAT_REPORT_REASON_LABEL).sort()).toEqual(reasons);
    expect(Object.keys(CHAT_REPORT_STATUS_LABEL).sort()).toEqual(serverList(CONTRACT, 'CHAT_REPORT_STATUSES'));
    expect(Object.keys(CHAT_ACTION_LABEL).sort()).toEqual(serverList(CONTRACT, 'CHAT_MODERATION_ACTIONS'));
  });

  it('offer the server’s default action first, so the form starts where the server would', () => {
    const controller = readFileSync(join(V3, 'services/chat/src/chat-moderation.controller.ts'), 'utf8');
    expect(controller).toContain("dto.action ?? 'warn_sender'");
    expect(Object.keys(CHAT_ACTION_LABEL)[0]).toBe('warn_sender');
  });

  it('show a neutral word for a reason, status or action they have never heard of', () => {
    expect(chatReportReasonLabel('doxxing')).toBe(UNKNOWN_REASON_LABEL);
    expect(chatReportStatusView('escalated')).toEqual({ label: UNKNOWN_STATUS_LABEL, tone: 'neutral' });
    expect(chatActionLabel('ban_forever')).toBe(UNKNOWN_ACTION_LABEL);
  });

  it('refuse with ONE 404 on the server — so one message is honest for missing, foreign, expired and lost-the-race', () => {
    const controller = readFileSync(join(V3, 'services/chat/src/chat-moderation.controller.ts'), 'utf8');
    const throws = [...controller.matchAll(/throw new (\w+)/g)].map((m) => m[1]);
    expect(throws.length).toBeGreaterThanOrEqual(2); // the read and the decide
    expect(new Set(throws)).toEqual(new Set(['NotFoundOrNotYoursException']));
    const exception = readFileSync(join(V3, 'libs/ownership/src/not-found-or-not-yours.exception.ts'), 'utf8');
    expect(exception).toContain('extends NotFoundException');
  });

  it('never claim, in that one message, that a colleague decided the report', () => {
    for (const copy of [CHAT_REPORT_UNAVAILABLE, CHAT_REPORT_UNREADABLE]) {
      expect(copy).not.toMatch(/همکار|اپراتور دیگر|ناظر دیگر|پیش‌تر/);
    }
    expect(CHAT_REPORT_UNAVAILABLE).toBe('این گزارش دیگر برای تصمیم‌گیری در دسترس نیست. صف را تازه کنید.');
  });
});

describe('privacy requests', () => {
  const ENTITY = 'services/privacy/src/entities/data-request.entity.ts';

  it('name exactly the statuses a request can have — which is also every option of the status filter', () => {
    const server = serverList(ENTITY, 'DATA_REQUEST_STATUSES');
    expect(server.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(PRIVACY_STATUS_LABEL).sort()).toEqual(server);
  });

  it('give every status its own word — an operator watching a stuck sweep needs pending and processing apart', () => {
    const labels = Object.values(PRIVACY_STATUS_LABEL).map((view) => view.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('name exactly the two kinds', () => {
    expect(Object.keys(PRIVACY_KIND_LABEL).sort()).toEqual(serverList(ENTITY, 'DATA_REQUEST_KINDS'));
  });

  it('show a neutral word for a status or kind they have never heard of', () => {
    expect(privacyStatusView('archived')).toEqual({ label: UNKNOWN_STATUS_LABEL, tone: 'neutral' });
    expect(privacyKindLabel('rectification')).toBe(UNKNOWN_KIND_LABEL);
  });
});
