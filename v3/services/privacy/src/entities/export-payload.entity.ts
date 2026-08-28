import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The generated export document, in its own table.
 *
 * Separated from `data_requests` because the two have different audiences and
 * that difference is a security boundary, not a normalization preference: an
 * operator lists requests, and no operator may ever read a payload. A route
 * that reads `DataRequestEntity` cannot return a document by accident, because
 * the document is not on the row it loaded.
 */
@Entity({ name: 'export_payloads', schema: 'privacy' })
export class ExportPayloadEntity {
  @PrimaryColumn('uuid')
  requestId!: string;

  @Column({ type: 'jsonb' })
  document!: Record<string, unknown>;

  /** BIGINT comes back from node-postgres as a string; the service converts explicitly. */
  @Column({ type: 'bigint' })
  byteSize!: string;

  @Column({ type: 'char', length: 64 })
  checksumSha256!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  generatedAt!: Date;
}
