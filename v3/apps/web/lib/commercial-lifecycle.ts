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

/** A `datetime-local` value (the browser's wall clock) as the ISO instant the API takes. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An ISO instant as a `datetime-local` value, for editing a draft. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
