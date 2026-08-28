import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { MediaAccessClass } from '../storage/object-storage.port';
import { MediaPurpose } from '../media-policy';

export const MEDIA_OBJECT_STATUSES = ['pending', 'stored', 'deleted'] as const;
export type MediaObjectStatus = (typeof MEDIA_OBJECT_STATUSES)[number];

/**
 * One uploaded object.
 *
 * This row is the AUTHORIZATION STATE for the object; the storage key is
 * merely where the bytes are. Every read path re-derives permission from
 * here rather than from possession of a URL, which is what makes
 * `V3_SECURITY_MODEL.md` §8's "re-verify on every single request" true
 * rather than aspirational.
 *
 * The `pending -> stored -> deleted` lifecycle is not decoration either. With
 * presigned direct upload the API never sees the bytes in flight, so there is
 * a real interval during which a row exists and an object may or may not.
 * `pending` names that interval honestly; `stored` is only ever written by
 * `finalize`, after the object has been read back and sniffed. Nothing in the
 * product may reference an object that is not `stored`.
 */
@Entity({ name: 'objects', schema: 'media' })
export class MediaObjectEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * Who uploaded it. Always the authenticated session's own id, resolved
   * server-side -- there is no owner parameter on any media route.
   */
  @Index()
  @Column({ type: 'uuid' })
  ownerUserId!: string;

  @Column({ type: 'varchar', length: 32 })
  purpose!: MediaPurpose;

  /** Denormalized from `MEDIA_POLICY[purpose]` at creation, so a later policy edit cannot retroactively expose stored evidence. */
  @Column({ type: 'varchar', length: 16 })
  accessClass!: MediaAccessClass;

  @Column({ type: 'varchar', length: 16 })
  status!: MediaObjectStatus;

  /** Which driver wrote it. A deployment that switches drivers must not silently address old keys through the new one. */
  @Column({ type: 'varchar', length: 16 })
  storageDriver!: string;

  @Column({ type: 'text' })
  storageKey!: string;

  /** What the client said on the way in. Kept for diagnostics; never used as truth. */
  @Column({ type: 'varchar', length: 100 })
  declaredContentType!: string;

  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  declaredByteSize!: number;

  /** What the bytes actually are. Written by `finalize` from `probeImage`, never from a header. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  contentType!: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) },
  })
  byteSize!: number | null;

  /** Intrinsic pixel dimensions. The zero-layout-shift requirement is served from these two columns. */
  @Column({ type: 'int', nullable: true })
  width!: number | null;

  @Column({ type: 'int', nullable: true })
  height!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  /** Set when a moderator takes the object down, so a takedown is distinguishable from an owner's delete. */
  @Column({ type: 'uuid', nullable: true })
  takenDownBy!: string | null;
}
