import { InsertQueryBuilder, ObjectLiteral } from 'typeorm';

/**
 * Runs an `INSERT ... ON CONFLICT DO NOTHING` and reports whether a row was
 * ACTUALLY inserted.
 *
 * This exists because the obvious way to ask that question is wrong, and
 * wrong in a way that silently disables idempotency:
 *
 *   const result = await qb.insert().values({ id, ... }).orIgnore().execute();
 *   const won = result.identifiers.some(Boolean);   // <-- WRONG
 *
 * TypeORM populates `identifiers` from the values the CALLER supplied, not
 * from what the database returned. When the id is generated in application
 * code -- which every entity here does, using uuidv7 -- `identifiers` comes
 * back populated whether or not the insert hit a conflict. So `won` is always
 * true, every duplicate looks like a fresh insert, and a guard that reads
 * correctly does nothing at all.
 *
 * Caught by a real-PostgreSQL test asserting that a redelivered
 * `BookingCompleted` awards no second points: the row count was correct
 * (the unique index did its job) but the return value claimed an award had
 * happened, which would have driven a second tier-crossing check, a second
 * membership sync, and a second notification.
 *
 * The fix is to make PostgreSQL answer: `RETURNING` emits a row only for
 * rows that were genuinely inserted, so `raw.length` is the true count. That
 * makes the check independent of how the id was produced.
 */
export async function insertOnce<T extends ObjectLiteral>(
  builder: InsertQueryBuilder<T>,
  returningColumn = 'id',
): Promise<boolean> {
  const result = await builder.orIgnore().returning(returningColumn).execute();
  return Array.isArray(result.raw) && result.raw.length > 0;
}
