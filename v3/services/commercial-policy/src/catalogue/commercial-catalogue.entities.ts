import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { CatalogueLifecycleState, PriceSchedulePurpose } from '@beauclick/commercial-policy-contract';

/**
 * The five tables of ADR-041's catalogue.
 *
 * ## Read these as read-mostly projections of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. The lifecycle allow-list, the immutability of
 * a published version, the non-overlap of activation windows, the completeness
 * of a tier set and the base workspace's zero price are all in
 * `database/migrations/commercial/`, because a guarantee upheld by an entity is
 * upheld by whoever remembers to go through the entity.
 *
 * These classes exist so the service can read and write through the same
 * DataSource, the same transaction and the same repository API as every other
 * domain — not to restate the constraints.
 *
 * ## `synchronize` is off everywhere (ADR-015)
 *
 * So the generated `quantity_range` column on `price_tiers` is deliberately
 * NOT mapped: TypeORM cannot express a stored generated `int4range`, and a
 * partially-correct mapping of a column the database computes is worse than no
 * mapping at all.
 */

@Entity({ name: 'plans', schema: 'commercial' })
export class CommercialPlanEntity {
  @PrimaryColumn({ name: 'plan_key', type: 'varchar', length: 64 })
  planKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** The authenticated session's own user id. Never accepted from a request. */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  /** Present exactly when `createdByUserId` is null; a DB CHECK enforces the pairing. */
  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'price_schedules', schema: 'commercial' })
export class CommercialPriceScheduleEntity {
  @PrimaryColumn({ name: 'schedule_key', type: 'varchar', length: 64 })
  scheduleKey!: string;

  @Column({ name: 'purpose', type: 'varchar', length: 24 })
  purpose!: PriceSchedulePurpose;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'price_schedule_versions', schema: 'commercial' })
export class CommercialPriceScheduleVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'schedule_key', type: 'varchar', length: 64 })
  scheduleKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  /** Pinned to `IRT` by a database CHECK (`V33-DEC-009`). */
  @Column({ name: 'currency_code', type: 'char', length: 3 })
  currencyCode!: string;

  @Column({ name: 'min_purchase_quantity', type: 'int' })
  minPurchaseQuantity!: number;

  @Column({ name: 'max_purchase_quantity', type: 'int' })
  maxPurchaseQuantity!: number;

  /** Presentation only, never a contract limit. Values open under #46. */
  @Column({ name: 'ui_preset_quantities', type: 'int', array: true })
  uiPresetQuantities!: number[];

  @Column({ name: 'activation_starts_at', type: 'timestamptz' })
  activationStartsAt!: Date;

  @Column({ name: 'activation_ends_at', type: 'timestamptz', nullable: true })
  activationEndsAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'published_by_user_id', type: 'uuid', nullable: true })
  publishedByUserId!: string | null;

  @Column({ name: 'published_by_label', type: 'varchar', length: 40, nullable: true })
  publishedByLabel!: string | null;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;

  @Column({ name: 'retired_by_user_id', type: 'uuid', nullable: true })
  retiredByUserId!: string | null;

  @Column({ name: 'retired_by_label', type: 'varchar', length: 40, nullable: true })
  retiredByLabel!: string | null;
}

@Entity({ name: 'price_tiers', schema: 'commercial' })
export class CommercialPriceTierEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'schedule_version_id', type: 'uuid' })
  scheduleVersionId!: string;

  @Column({ name: 'min_quantity', type: 'int' })
  minQuantity!: number;

  /** NULL is unbounded above, and is legal on the highest tier only. */
  @Column({ name: 'max_quantity', type: 'int', nullable: true })
  maxQuantity!: number | null;

  /**
   * Integer Toman, the platform's single money representation.
   *
   * `bigint` reaches JavaScript as a STRING through the pg driver, which is
   * correct for a column that can exceed 2^53 and wrong for arithmetic done in
   * ignorance of it. The transformer converts on read and asserts the value is
   * a safe integer, so a price that could not survive a sum fails loudly here
   * rather than silently in a total.
   */
  @Column({
    name: 'unit_price_toman',
    type: 'bigint',
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number | null): number => {
        if (value === null) return 0;
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isSafeInteger(parsed)) {
          throw new Error(`commercial.price_tiers.unit_price_toman is not a safe integer: ${String(value)}`);
        }
        return parsed;
      },
    },
  })
  unitPriceToman!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'plan_versions', schema: 'commercial' })
export class CommercialPlanVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'plan_key', type: 'varchar', length: 64 })
  planKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  /** NULL means no recurring term — not zero, which reads as "renews immediately". */
  @Column({ name: 'billing_term_days', type: 'int', nullable: true })
  billingTermDays!: number | null;

  @Column({ name: 'included_booking_credits', type: 'int' })
  includedBookingCredits!: number;

  @Column({ name: 'staff_seats', type: 'int' })
  staffSeats!: number;

  @Column({ name: 'included_locations', type: 'int' })
  includedLocations!: number;

  @Column({ name: 'capability_keys', type: 'text', array: true })
  capabilityKeys!: string[];

  @Column({ name: 'price_schedule_version_id', type: 'uuid' })
  priceScheduleVersionId!: string;

  /**
   * The base workspace mechanism (ADR-041 §6).
   *
   * A row's property, so no code anywhere names `D-7`. A database exclusion
   * constraint keeps at most one auto-assignable version active at any instant.
   */
  @Column({ name: 'auto_assignable', type: 'boolean' })
  autoAssignable!: boolean;

  @Column({ name: 'activation_starts_at', type: 'timestamptz' })
  activationStartsAt!: Date;

  @Column({ name: 'activation_ends_at', type: 'timestamptz', nullable: true })
  activationEndsAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;

  /**
   * Issue #40 names this column, and ADR-041 §10 records the consequence: the
   * table's ADR-027 disposition is `retained` with a stated reason, never
   * `no_subject_data`, and the column is not renamed to evade the coverage
   * check that recognises the `_user_id` suffix.
   */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'published_by_user_id', type: 'uuid', nullable: true })
  publishedByUserId!: string | null;

  @Column({ name: 'published_by_label', type: 'varchar', length: 40, nullable: true })
  publishedByLabel!: string | null;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;

  @Column({ name: 'retired_by_user_id', type: 'uuid', nullable: true })
  retiredByUserId!: string | null;

  @Column({ name: 'retired_by_label', type: 'varchar', length: 40, nullable: true })
  retiredByLabel!: string | null;
}

/**
 * Registered on the MAIN DataSource by the composition root.
 *
 * Ordinary application-role tables on the shared pool: this is an entitlement
 * catalogue and not the ledger (ADR-041 §11), so it needs neither `financial`'s
 * second DataSource nor `admin`'s owner-role isolation. The application both
 * reads and writes every one of them, and the immutability comes from triggers
 * on rows it owns rather than from a connection-level grant.
 */
export const COMMERCIAL_ENTITIES = [
  CommercialPlanEntity,
  CommercialPriceScheduleEntity,
  CommercialPriceScheduleVersionEntity,
  CommercialPriceTierEntity,
  CommercialPlanVersionEntity,
];
