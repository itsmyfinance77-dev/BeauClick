import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export const ABUSE_REPORT_STATUSES = ['open', 'upheld', 'rejected'] as const;
export type AbuseReportStatus = (typeof ABUSE_REPORT_STATUSES)[number];

export const ABUSE_REPORT_REASONS = ['not_own_work', 'explicit', 'misleading', 'personal_data', 'other'] as const;
export type AbuseReportReason = (typeof ABUSE_REPORT_REASONS)[number];

/**
 * A report that a PUBLIC media object should not be public.
 *
 * `V3.1_PRODUCT_ROADMAP.md` §15's Phase C names "an abuse-report path" among
 * the security requirements of making the marketplace visual, and it is the
 * one of the four that is not a validation rule: content-type checks, size
 * caps, and quota all constrain what arrives, while this is the only route
 * by which a human says an image that passed every check should still come
 * down.
 *
 * SCOPE, stated because the boundary is easy to widen by accident: only
 * `public` objects are reportable. Protected objects -- verification
 * evidence -- are visible to nobody except the submitter and a moderator
 * reviewing the request, so there is no member of the public who could
 * report one, and accepting a report against a protected id would leak that
 * the id exists.
 */
@Entity({ name: 'abuse_reports', schema: 'media' })
export class MediaAbuseReportEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  mediaObjectId!: string;

  /** The reporting session's own user id. Never accepted from the body. */
  @Column({ type: 'uuid' })
  reportedBy!: string;

  @Column({ type: 'varchar', length: 32 })
  reason!: AbuseReportReason;

  /** Free text from the reporter. Never enters an event payload or an audit snapshot. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: AbuseReportStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;
}
