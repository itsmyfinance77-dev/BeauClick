import { MediaAccessClass } from './storage/object-storage.port';

/**
 * What may be uploaded, how large, how many, and who may read it back.
 *
 * ONE table, consulted by every path. The alternative -- each feature
 * checking its own caps at its own call site -- is how a fourth upload
 * surface ends up with no quota at all, and it is why this lives beside the
 * service rather than inside it.
 *
 * `accessClass` is the load-bearing column. `V3_SECURITY_MODEL.md` §8
 * requires that a private file be "stored outside any publicly-addressable,
 * predictable path" and that authorization be re-checked "on every single
 * request". Verification evidence is a scan of somebody's identity document;
 * portfolio work is meant to be seen by strangers. Two access classes, one
 * storage layer -- and the boundary is declared here, once, instead of being
 * a property each route remembers to get right.
 */

export const MEDIA_PURPOSES = ['portfolio', 'avatar', 'cover', 'verification_evidence'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export interface MediaPurposePolicy {
  accessClass: MediaAccessClass;
  /** Hard cap on the stored object, in bytes. Enforced against the STORE's reported size. */
  maxBytes: number;
  /**
   * How many `stored` objects one user may hold for this purpose.
   *
   * Counted over `media.objects`, not over the referencing domain's rows, so
   * an object uploaded and never attached still consumes quota. That is
   * deliberate: quota exists to bound storage cost and abuse, and an
   * orphaned object costs exactly as much as an attached one.
   */
  perUserQuota: number;
  /** Smallest acceptable edge, in pixels. Below this the image is unusable at any surface. */
  minEdgePx: number;
  /**
   * Largest acceptable edge, in pixels.
   *
   * Not a cosmetic limit: an image can be a few hundred kilobytes on disk
   * and still decode to gigabytes in memory, so a byte cap alone does not
   * bound what a downstream renderer has to handle.
   */
  maxEdgePx: number;
}

export const MEDIA_POLICY: Record<MediaPurpose, MediaPurposePolicy> = {
  portfolio: { accessClass: 'public', maxBytes: 8 * 1024 * 1024, perUserQuota: 40, minEdgePx: 200, maxEdgePx: 8000 },
  avatar: { accessClass: 'public', maxBytes: 4 * 1024 * 1024, perUserQuota: 5, minEdgePx: 200, maxEdgePx: 4000 },
  cover: { accessClass: 'public', maxBytes: 8 * 1024 * 1024, perUserQuota: 5, minEdgePx: 400, maxEdgePx: 8000 },
  verification_evidence: {
    accessClass: 'protected',
    maxBytes: 8 * 1024 * 1024,
    perUserQuota: 10,
    minEdgePx: 200,
    maxEdgePx: 8000,
  },
};

/**
 * The content types a client may DECLARE.
 *
 * Note this is the declared-type allow-list, not the accepted-content list.
 * What is actually accepted is decided by `probeImage` against the stored
 * bytes; this list only exists so an obviously-wrong grant is refused before
 * an object is ever created. Both checks are required and neither is
 * sufficient: the declaration is cheap to refuse early, and the sniff is the
 * one that cannot be lied to.
 */
export const ALLOWED_DECLARED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * How long an upload grant stays usable.
 *
 * Long enough for a slow mobile upload of the largest permitted file;
 * short enough that a URL copied out of a browser's network panel is not a
 * durable write capability.
 */
export const UPLOAD_GRANT_TTL_SECONDS = 15 * 60;

/**
 * How long a protected-download URL stays usable.
 *
 * Deliberately much shorter than the upload grant: it carries no state of
 * its own, so its only defence against being forwarded is that it expires.
 * The authorization re-check on every request (§8) is the real control; this
 * bounds the window in which that check is even reached.
 */
export const PROTECTED_DOWNLOAD_TTL_SECONDS = 5 * 60;

/**
 * How many `pending` grants one user may hold at once.
 *
 * Without this, `POST /v1/media/upload-url` is an unbounded row-creation
 * endpoint: quota only counts `stored` objects, so a client that requests
 * grants and never uploads would consume none of it. Rate limiting bounds
 * the rate; this bounds the outstanding total.
 */
export const MAX_PENDING_GRANTS_PER_USER = 10;
