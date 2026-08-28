/**
 * The object-storage abstraction (R31-03).
 *
 * Shaped after the two provider abstractions this codebase has already
 * proved -- `PaymentProvider` (ADR-006) and `NotificationChannelPort` --
 * and for the same reason each of those gives: the hosting/region decision
 * (`V3.1_PRODUCT_ROADMAP.md` §12 #1) names a VENDOR, and a vendor choice
 * must not be a code change. `V3_INFRASTRUCTURE_PLAN.md` §5 already fixes
 * the architecture -- "S3-compatible, Iran-reachable provider" -- so what
 * remains outstanding is an endpoint, a bucket, and a credential pair.
 * Those are deployment configuration, and they are the ONLY thing this
 * phase leaves open.
 *
 * Three rules every driver must honour, all of them security properties:
 *
 *  1. **An upload target is scoped to exactly one object key.** It may never
 *     be usable to write any other key, in any bucket, under any prefix. A
 *     grant that can be pointed elsewhere is an arbitrary-write primitive
 *     handed to whoever asked for it.
 *  2. **An upload target expires.** A presigned URL with no expiry is a
 *     permanent credential embedded in a browser's history.
 *  3. **A driver never decides whether content is acceptable.** It moves
 *     bytes. Content-type sniffing, size caps, and quota all happen in
 *     `MediaService`, server-side, on data read back FROM storage -- never
 *     from what the client claimed on the way in. A driver that validated
 *     would put that decision behind an interface where a second driver
 *     could quietly implement it differently.
 */

export type MediaAccessClass = 'public' | 'protected';

export interface UploadTargetRequest {
  /** The one key this grant may write. Driver-opaque, allocated by `MediaService`. */
  objectKey: string;
  /** What the client says it will send. Signed into the target where the driver can; never trusted as truth. */
  contentType: string;
  /** The exact byte count the client declared. Enforced here where the driver can, and again at finalize. */
  declaredByteSize: number;
  expiresInSeconds: number;
  accessClass: MediaAccessClass;
}

export interface UploadTarget {
  /** Where the client PUTs the bytes. Absolute. */
  url: string;
  method: 'PUT';
  /**
   * Headers the client MUST send verbatim.
   *
   * Returned rather than assumed because they are part of what was signed:
   * an S3 presigned PUT whose `content-type` differs from the signed value
   * is rejected by the store, and a client that guesses will get a 403 it
   * cannot diagnose.
   */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectHead {
  exists: boolean;
  byteSize: number | null;
  /** What the STORE believes. Still only a claim -- the sniff in `MediaService` is what decides. */
  contentType: string | null;
}

export interface ObjectStorageDriver {
  /** Stable key, persisted on every object this driver wrote. */
  readonly key: string;

  /**
   * Whether this driver talks to a genuinely integrated external store.
   *
   * Reported by the health surface, exactly as `NotificationChannelPort`
   * does. A driver writing to the API host's own disk must never be
   * indistinguishable from one writing to durable object storage: V2 shipped
   * a "local development only" payment stand-in whose status was UI text with
   * no mechanism behind it, and Phase 2 found it.
   */
  readonly durable: boolean;

  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget>;

  head(objectKey: string): Promise<StoredObjectHead>;

  /**
   * Reads a byte range. Used for magic-number sniffing and image-header
   * parsing at finalize -- deliberately a RANGE and not a full read, because
   * a finalize path that downloads whole objects is a memory-exhaustion
   * vector on a route any authenticated user can call.
   */
  readRange(objectKey: string, start: number, endInclusive: number): Promise<Buffer>;

  /** The whole object. Only ever called for a `protected` object being served to an authorized viewer. */
  read(objectKey: string): Promise<Buffer>;

  /** Idempotent: deleting an absent object is a success, not an error. */
  delete(objectKey: string): Promise<void>;

  /**
   * Accepts an upload this process is itself terminating.
   *
   * Present only on drivers whose upload target points back at this API --
   * today that is the local driver alone. A driver that hands out a real
   * presigned URL to an external store never sees the bytes and must NOT
   * implement this: the absence is what makes `PUT /v1/media/upload/:token`
   * answer 404 rather than half-working when the deployment is on S3.
   */
  acceptDirectUpload?(objectKey: string, body: Buffer): Promise<void>;

  /**
   * The publicly addressable URL for a `public` object, or `null` when this
   * driver has no public surface.
   *
   * Never called for a `protected` object. That is enforced in
   * `MediaService`, not here, so a driver cannot accidentally make evidence
   * addressable by implementing this one method too helpfully.
   */
  publicUrl(objectKey: string): string | null;
}

/** Nest injection token for the single configured driver. */
export const OBJECT_STORAGE_DRIVER = Symbol('BEAUCLICK_OBJECT_STORAGE_DRIVER');
