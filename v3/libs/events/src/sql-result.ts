/**
 * Normalizes what TypeORM's `query()` hands back for a `RETURNING` statement.
 *
 * TypeORM's PostgreSQL driver returns different shapes depending on the SQL
 * command:
 *
 *   SELECT            -> `rows`
 *   INSERT            -> `rows`
 *   UPDATE / DELETE   -> `[rows, rowCount]`
 *
 * So `result[0]` is a ROW after a SELECT and an ARRAY OF ROWS after an UPDATE,
 * and `result.length` is the row count in one case and always 2 in the other.
 * Nothing in the type signature says so -- `query()` is typed `any`.
 *
 * This has now caused two real, separately-diagnosed bugs in this codebase,
 * both of which produced a plausible wrong answer rather than an error:
 *
 *   1. `ProviderEventsService.bumpRevision` read `raw[0].revision`, got
 *      `undefined`, and a `?? 1` fallback turned that into a revision that
 *      never advanced. Every event claimed revision 1, so search-service's
 *      ordering guard discarded everything after the first and a verification
 *      change never reached the index.
 *
 *   2. `TokenService.rotate` checked `claimed.length === 0` to detect "this
 *      token could not be claimed". Against `[rows, rowCount]` that length is
 *      always 2, so the guard never fired -- and a REVOKED refresh token
 *      successfully minted a new session.
 *
 * Both were caught only by tests against a real PostgreSQL server. A helper
 * exists so the next author does not have to rediscover it a third time.
 */
export function returningRows<T = Record<string, unknown>>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  // The UPDATE/DELETE shape: a rows array followed by a numeric count.
  if (Array.isArray(raw[0])) return raw[0] as T[];
  return raw as T[];
}

/** Convenience for the very common "did this statement affect anything" question. */
export function affectedAny(raw: unknown): boolean {
  return returningRows(raw).length > 0;
}
