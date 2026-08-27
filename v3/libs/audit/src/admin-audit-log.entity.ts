import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** The bounded shape a before/after snapshot may take. Never a spread entity. */
export type AuditSnapshot = Record<string, string | number | boolean | null>;

/**
 * One administrative action, recorded permanently.
 *
 * The append-only guarantee is a PostgreSQL GRANT, not an application
 * convention: `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner`
 * (a role the application never connects as) and the application role holds
 * INSERT + SELECT and nothing else. Because it is not the owner it cannot grant
 * itself back UPDATE -- the same reasoning ADR-017 applies to the financial
 * ledger, and the same reason V2 could never achieve it (its MySQL hosting
 * lacked the grants its trigger approach needed -- GAP-01).
 *
 * There is deliberately no `update`, `save`, or `remove` path anywhere in this
 * library. Even if one were written, the database would refuse it.
 */
@Entity({ name: 'admin_audit_log', schema: 'admin' })
export class AdminAuditLogEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * The authenticated session's own user id, resolved server-side. NULL only
   * for the documented one-time bootstrap, which by definition has no
   * privileged account to act as -- and which still writes a row, so even the
   * first grant in a deployment's life is auditable.
   */
  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null;

  /** Present exactly when `actorUserId` is null; a DB CHECK enforces the pairing. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  actorLabel!: string | null;

  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ type: 'varchar', length: 40 })
  targetType!: string;

  /** VARCHAR, not UUID: a reindex targets an index alias by name, not a row. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  targetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  beforeState!: AuditSnapshot | null;

  @Column({ type: 'jsonb', nullable: true })
  afterState!: AuditSnapshot | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
