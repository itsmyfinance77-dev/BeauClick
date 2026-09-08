/**
 * Reading "did that statement actually write?" out of a raw TypeORM query.
 *
 * ## Why this exists rather than an inline `result[1]`
 *
 * `PostgresQueryRunner.query` returns **two different shapes**, chosen by
 * sniffing the command name:
 *
 * ```
 *   UPDATE / DELETE  ->  [rows, rowCount]
 *   everything else  ->  rows
 * ```
 *
 * INSERT falls into "everything else". A helper that assumed `[rows, rowCount]`
 * for all three therefore read `result[1]` as `undefined` after every INSERT and
 * reported **zero rows written** — permanently, and silently, because the
 * statement itself had succeeded.
 *
 * That is not a hypothetical. It is the defect this file was extracted to fix:
 * the first cut of V3.3 Story #109 (`#44c`) used exactly that assumption at
 * three call sites, and the result was a scoped grant that committed with no
 * audit row, a revocation that committed with no audit row, and an invitation
 * that created a real membership and then took its "already a member" early
 * return — skipping the outbox event, the audit row and the notification. Every
 * one of those paths returned success.
 *
 * ## The rule this module now follows
 *
 * **Every statement whose effect is tested asks for `RETURNING`, and the test is
 * on real returned rows.** That is true under both shapes, so it cannot be
 * broken again by a driver that changes its mind about which commands get a
 * count — and a reviewer can see what is being counted instead of trusting a
 * positional index.
 */

/**
 * The rows a statement RETURNED, normalised across both driver shapes.
 *
 * The `[rows, rowCount]` form is recognised structurally — a two-element array
 * whose first element is itself an array and whose second is a number. Real
 * returned rows are objects, so a genuine two-row result cannot be mistaken for
 * it.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return result as T[];
}
