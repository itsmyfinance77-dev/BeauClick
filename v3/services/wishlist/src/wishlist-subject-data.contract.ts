import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { WishlistService } from './wishlist.service';

/**
 * `wishlist`'s subject-data contract — `V32-DEC-020`, ADR-033 §9.
 *
 * ## This module DELETES, and that is the opposite of the platform default
 *
 * The platform's erasure model is anonymisation with referential integrity: keep
 * the row, destroy the identity it points at. That default exists because most
 * rows are half of a two-party fact — a booking the professional still needs, an
 * order the ledger references, a message the counterparty wrote.
 *
 * **Nothing here is like that.** A saved item is one person's stated preference:
 * a `user_id`, an enum, a target id, and an instant. It is single-party, and it
 * is referenced by nobody — there is no foreign key pointing at this table from
 * anywhere in the platform, and there deliberately never will be.
 *
 * For rows like that, keeping them would be keeping personal data for no reason,
 * so they go. `journey` reached the same conclusion for beauty profiles and
 * goals and its contract states the rule plainly; applying the anonymisation
 * default here out of consistency would be the wrong answer arrived at by
 * rule-following.
 *
 * ## Why erasure does not produce a tombstone, even though the module has one
 *
 * `V32-DEC-021`'s neutral tombstone is about a **target** becoming unavailable
 * while the customer still exists — the row survives so the customer can see and
 * remove it. Erasure is the other direction: the customer is gone, so there is
 * nobody the row could be shown to and nobody it describes any more. The two are
 * unrelated, and conflating them would leave rows behind that serve no one.
 */
@Injectable()
export class WishlistSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'wishlist';

  /**
   * The module's entire physical footprint: one table.
   *
   * Nothing here is `no_subject_data`. There is no catalogue table, no
   * projection, and no outbox — `wishlist` emits no events and is not in
   * `ServiceName` (ADR-033 §10), so it has no `outbox_events` table to claim.
   *
   * The identity column is named `user_id`, which ADR-027's coverage heuristic
   * recognises — so a `no_subject_data` claim on this table would be rejected at
   * boot on the strength of the column name alone, even if somebody wrote one.
   */
  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'wishlist.saved_items', disposition: 'subject_data' },
  ];

  constructor(private readonly wishlist: WishlistService) {}

  /**
   * Everything this module holds about the subject.
   *
   * Every saved item, oldest first, read through the caller's `EntityManager` so
   * the whole export is one consistent snapshot.
   *
   * **Only ids and an instant.** No display name, no price, no image — this
   * module stores none of that (ADR-033 §7), so an export cannot leak a third
   * party's catalogue data even by accident. What the subject gets is a truthful
   * record of what they chose to save and when, which is exactly what they
   * authored.
   */
  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const items = await this.wishlist.allForSubject(manager, userId);

    return [
      {
        key: 'wishlist_items',
        description: 'موردهایی که در فهرست علاقه‌مندی‌های خود ذخیره کرده‌اید',
        rows: items.map((item) => ({
          targetType: item.targetType,
          targetId: item.targetId,
          savedAt: item.createdAt,
        })),
      },
    ];
  }

  /**
   * Destroys every saved item the subject holds.
   *
   * A hard `DELETE`, inside the caller's transaction alongside every other
   * module's, so a failure anywhere leaves the subject fully intact rather than
   * half erased.
   *
   * `retained` is empty and that is the honest report: this module keeps nothing.
   */
  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    const result = await manager.query('DELETE FROM wishlist.saved_items WHERE user_id = $1', [userId]);

    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: rowCount(result),
      retained: [],
    };
  }
}

/**
 * How many rows a write actually touched.
 *
 * TypeORM's postgres driver returns `[rows, rowCount]` for `UPDATE` and
 * `DELETE`, including when the statement carries `RETURNING`. Counting
 * `result.length` therefore reports 2 for every such statement — the defect
 * V3.2-B recorded as bug #3, where it made an erasure report a fabricated count
 * and made a compare-and-swap unable to observe its own loss.
 */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
