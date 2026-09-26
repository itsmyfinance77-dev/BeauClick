import { zonedDateTimeToInstant, zonedIsoDate, zonedIsoTime } from '@beauclick/persian-utils';
import { ApiRequestError } from './api-client';
import type { LifecycleVersion } from './commercial-admin-api';
import type { DerivedState } from './commercial-labels';

/**
 * The version lifecycle every commercial family shares (#239), as plain
 * functions: what a version's derived state is, and what a refusal says.
 *
 * Kept free of React so the commission policy page can adopt it later as a
 * follow-up rather than a rewrite.
 */

/**
 * A PUBLISHED version's position against its activation window — `active`,
 * `scheduled` (not started yet) or `superseded` (its window closed).
 *
 * Derived, never stored: the server reports only draft / published / retired,
 * and a published version whose window has closed is still `published`. The
 * rule is the one `commission-policy-view.tsx` `effectiveVersion()` already
 * applies — start at or before now, and no end or an end after now — measured
 * with the browser's clock, so it is labelled as derived wherever it appears.
 */
export function derivedState(version: LifecycleVersion, now: number = Date.now()): DerivedState | null {
  if (version.lifecycleState !== 'published') return null;
  if (!version.activationStartsAt) return null;
  if (new Date(version.activationStartsAt).getTime() > now) return 'scheduled';
  if (version.activationEndsAt !== null && new Date(version.activationEndsAt).getTime() <= now) return 'superseded';
  return 'active';
}

/** The version in effect right now, or `null`. Two can never overlap — the database refuses it. */
export function activeVersion<V extends LifecycleVersion>(versions: readonly V[], now: number = Date.now()): V | null {
  return versions.find((version) => derivedState(version, now) === 'active') ?? null;
}

/**
 * The server's refusal, held as data.
 *
 * `message` is always the server's own Persian text (`api-client.ts`: the
 * client never invents or patches error copy). The structured parts are the
 * `details` two codes carry: `COMMERCIAL_TERMS_INVALID`'s list of problems,
 * shown verbatim (spec 40 §2), and `COMMERCIAL_LIFECYCLE_CONFLICT` /
 * `COMMERCIAL_NOT_CONFIGURED`'s `detail`. The enforcement activation refusal
 * carries the preview's counts.
 */
export interface Refusal {
  code: string;
  message: string;
  problems: string[];
  detail: string | null;
  counts: Record<string, number> | null;
}

export function refusalFrom(err: unknown, fallback = 'این تغییر ثبت نشد.'): Refusal {
  if (!(err instanceof ApiRequestError)) {
    return { code: 'UNKNOWN', message: err instanceof Error ? err.message : fallback, problems: [], detail: null, counts: null };
  }
  const details = (err.details ?? {}) as Record<string, unknown>;
  const problems = Array.isArray(details.problems) ? details.problems.filter((p): p is string => typeof p === 'string') : [];
  const detail = typeof details.detail === 'string' ? details.detail : null;
  const counts =
    err.code === 'COMMERCIAL_ENFORCEMENT_ACTIVATION_REFUSED'
      ? Object.fromEntries(Object.entries(details).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : null;
  return { code: err.code, message: err.message, problems, detail, counts };
}

/**
 * Whether a refusal means the list on screen is stale: somebody else moved the
 * version (it stopped being a draft), or it is gone. The page reloads the
 * family — and keeps the form and the typed reason where they are.
 */
export function refusalMeansStale(refusal: Refusal): boolean {
  return refusal.code === 'COMMERCIAL_LIFECYCLE_CONFLICT' || refusal.code === 'COMMERCIAL_NOT_FOUND';
}

/*
 * An activation window's `datetime-local` fields mean the PLATFORM's wall
 * clock (#321). The instant a price schedule, plan, collection or outcome
 * policy starts or stops applying is one the whole platform shares, so it is
 * never read in the operator's own zone: `new Date('2026-01-01T09:00')` on a
 * UTC machine is 12:30 Tehran, and reading it back the same way shows 09:00
 * again -- self-consistent, so the three-and-a-half-hour error never shows.
 * The conversion is `@beauclick/persian-utils`' own, the one the availability
 * editor and every date display already use, and the labels below say so.
 */

/** The field labels, naming the zone the fields mean. Tied to `PLATFORM_TIMEZONE` by a test. */
export const ACTIVATION_START_LABEL = 'شروع فعال‌سازی (به وقت تهران)';
export const ACTIVATION_END_LABEL = 'پایان فعال‌سازی (اختیاری، به وقت تهران)';

const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * A `datetime-local` value, read as wall clock in `PLATFORM_TIMEZONE`, as the
 * ISO instant the API takes -- or `null` when it is empty or not a real
 * date and time (`2026-02-30T09:00` is not 2 March).
 */
export function localInputToIso(value: string): string | null {
  const match = DATETIME_LOCAL.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // Seconds and milliseconds, which a `datetime-local` carries only when typed
  // with a finer `step`, are kept rather than dropped.
  const millis = second * 1000 + Number((match[7] ?? '').padEnd(3, '0'));
  const instant = zonedDateTimeToInstant(`${match[1]}-${match[2]}-${match[3]}`, `${match[4]}:${match[5]}`);
  return new Date(instant.getTime() + millis).toISOString();
}

/** An ISO instant as a `datetime-local` value in `PLATFORM_TIMEZONE`, for editing a draft. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${zonedIsoDate(date)}T${zonedIsoTime(date)}`;
}

/**
 * A whole-number field's text as the integer it holds, or `null` when it holds
 * none. Nothing is rounded: `1.5`, `1e3` or `۱۲` typed as text is not an
 * integer the server would accept, and turning it into one would change the
 * value an administrator is about to publish.
 */
export function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
