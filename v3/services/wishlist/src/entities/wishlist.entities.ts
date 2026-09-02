import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

import type { WishlistTargetType } from '@beauclick/wishlist-contract';

/**
 * The saved item. One table, and the domain is complete.
 *
 * There is deliberately no `deleted_at`, no target-state column, no display
 * snapshot, no collection id, and no outbox entity anywhere in this module
 * (ADR-033 §§6, 7, 10). Each absence is a decision the migration's header
 * records at length; the short version:
 *
 *  * **No soft delete** — remove and erasure are both hard deletes, and a
 *    soft-delete column would make both claims false.
 *  * **No cached availability** — availability is computed per read, which is
 *    what lets a suspended-then-restored target come back with no write.
 *  * **No snapshot** — `provider` and `search` stay authoritative for public
 *    target data, and a snapshot would be bought in order to render exactly the
 *    name the neutral-tombstone rule forbids showing.
 *  * **No outbox** — nothing consumes a wishlist fact, and `wishlist` is not in
 *    `ServiceName`.
 */
@Entity({ name: 'saved_items', schema: 'wishlist' })
@Unique('uq_wishlist_saved_items_user_target', ['userId', 'targetType', 'targetId'])
@Index('ix_wishlist_saved_items_user_keyset', ['userId', 'createdAt', 'id'])
export class WishlistSavedItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * The owner.
   *
   * Named `user_id` rather than `customer_id` or anything cleverer because
   * ADR-027's coverage heuristic recognises that name: a `no_subject_data`
   * claim on this table would be rejected at boot on the strength of the column
   * name alone. The declared disposition and its test are the real guarantee;
   * the naming is belt, not braces.
   */
  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  /** `professional` or `service`. Closed by `V32-DEC-020` and by a CHECK constraint. */
  @Column({ type: 'varchar', length: 16 })
  targetType!: WishlistTargetType;

  /** `provider.professionals.id` or `provider.services.id`. No cross-schema FK, by convention and by decision. */
  @Column({ type: 'uuid' })
  targetId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

export const WISHLIST_ENTITIES = [WishlistSavedItemEntity];
