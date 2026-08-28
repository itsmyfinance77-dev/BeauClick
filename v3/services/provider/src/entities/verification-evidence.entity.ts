import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A document attached to one verification request.
 *
 * Bound to the REQUEST, not to the professional: a rejected request keeps the
 * evidence it was rejected on, and a resubmission is a new request with its
 * own. A moderator reviewing the second submission can therefore see what the
 * first one contained, which is the whole reason the queue records history at
 * all.
 *
 * The referenced media object is always `access_class = 'protected'`. It has
 * no public URL -- not an unlisted one, not a hard-to-guess one -- and the
 * only route to its bytes re-authorizes the caller on every request.
 */
@Entity({ name: 'verification_request_evidence', schema: 'provider' })
export class VerificationEvidenceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  requestId!: string;

  @Column({ type: 'uuid' })
  mediaId!: string;

  /** Always the submitting professional's own owner id, resolved from the session. */
  @Column({ type: 'uuid' })
  uploadedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
