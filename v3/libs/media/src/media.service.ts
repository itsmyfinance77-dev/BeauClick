import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager, In, IsNull, LessThan, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { DomainException } from '@beauclick/http';
import { PRIVILEGED_CAPABILITY_VERIFIER, PrivilegedCapabilityVerifier } from '@beauclick/auth';
import { AdminAuditService } from '@beauclick/audit';

import { MediaObjectEntity } from './entities/media-object.entity';
import { MediaAbuseReportEntity, AbuseReportReason } from './entities/media-abuse-report.entity';
import { IMAGE_PROBE_BYTES, probeImage } from './image-probe';
import {
  ALLOWED_DECLARED_CONTENT_TYPES,
  MAX_PENDING_GRANTS_PER_USER,
  MEDIA_POLICY,
  MediaPurpose,
  PROTECTED_DOWNLOAD_TTL_SECONDS,
  UPLOAD_GRANT_TTL_SECONDS,
} from './media-policy';
import { OBJECT_STORAGE_DRIVER, ObjectStorageDriver, UploadTarget } from './storage/object-storage.port';

export class MediaRejectedException extends DomainException {
  constructor(message: string, code = 'MEDIA_REJECTED') {
    super(code, message, HttpStatus.BAD_REQUEST);
  }
}

export class MediaQuotaExceededException extends DomainException {
  constructor(message: string) {
    super('MEDIA_QUOTA_EXCEEDED', message, HttpStatus.CONFLICT);
  }
}

/**
 * The one refusal every unauthorized media path produces.
 *
 * Identical for "no such object", "not yours", "not finalized", and "deleted"
 * -- `V3_SECURITY_MODEL.md` §3's must-not-leak-existence rule applied to
 * objects. A caller who can distinguish those four has an oracle for which
 * media ids exist.
 */
export class MediaNotFoundOrNotYoursException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export interface UploadGrant {
  mediaId: string;
  upload: UploadTarget;
}

/** What every consumer of a media object is allowed to see about it. */
export interface MediaDescriptor {
  id: string;
  /** Present only for a `public`, `stored` object. `null` for protected ones -- by construction, not by omission. */
  url: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
}

/**
 * The media lifecycle, and the only place that decides whether bytes are
 * acceptable or reachable.
 *
 * THE SHAPE, and why it is three steps rather than one upload endpoint.
 * ADR-013's infrastructure strategy and `V3.1_PRODUCT_ROADMAP.md` §15's
 * Phase C both specify PRESIGNED DIRECT UPLOAD: the browser sends the bytes
 * to the object store, not through the API. That is the right design -- an
 * API process that proxies 8 MB uploads is an API process whose memory and
 * connection budget is set by its slowest mobile client -- and it has one
 * unavoidable consequence: **the API never sees the request body.**
 *
 * Everything below follows from that consequence:
 *
 *   1. `createUploadGrant` -- checks quota, allocates a key nobody can
 *      guess, records a `pending` row, and asks the driver for a target
 *      scoped to that one key with an expiry.
 *   2. the client PUTs the bytes, to the store or (local driver) back to
 *      this API through a signed token route.
 *   3. `finalize` -- reads the object BACK from the store, sniffs what
 *      actually arrived, measures it, and only then marks it `stored`.
 *
 * Step 3 is where every content rule is enforced, because step 3 is the
 * first moment the platform can observe truth rather than a claim. A
 * validation performed in step 1 would be validating a promise.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger('MediaService');
  private readonly downloadTokenSecret: string;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(MediaObjectEntity) private readonly objects: Repository<MediaObjectEntity>,
    @InjectRepository(MediaAbuseReportEntity) private readonly reports: Repository<MediaAbuseReportEntity>,
    @Inject(OBJECT_STORAGE_DRIVER) private readonly storage: ObjectStorageDriver,
    private readonly audit: AdminAuditService,
    config: ConfigService,
    @Optional()
    @Inject(PRIVILEGED_CAPABILITY_VERIFIER)
    private readonly capabilities?: PrivilegedCapabilityVerifier,
  ) {
    this.downloadTokenSecret =
      config.get<string>('MEDIA_DOWNLOAD_TOKEN_SECRET') ??
      config.get<string>('JWT_ACCESS_SECRET') ??
      'dev-only-insecure-media-download-secret';
  }

  /** Reported by the health surface, so a deployment on non-durable storage is visible rather than assumed. */
  describeDriver(): { key: string; durable: boolean; publicReadConfigured: boolean } {
    return {
      key: this.storage.key,
      durable: this.storage.durable,
      publicReadConfigured: this.storage.publicUrl('probe') !== null,
    };
  }

  // ------------------------------------------------------------------ grant

  async createUploadGrant(
    ownerUserId: string,
    input: { purpose: MediaPurpose; contentType: string; byteSize: number },
  ): Promise<UploadGrant> {
    const policy = MEDIA_POLICY[input.purpose];
    if (!policy) throw new MediaRejectedException('نوع فایل درخواستی پشتیبانی نمی‌شود.');

    if (!(ALLOWED_DECLARED_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      throw new MediaRejectedException('فقط تصویر با فرمت JPEG، PNG یا WebP پذیرفته می‌شود.');
    }
    if (!Number.isInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > policy.maxBytes) {
      throw new MediaRejectedException(
        `حجم فایل باید بین ۱ بایت و ${Math.floor(policy.maxBytes / (1024 * 1024))} مگابایت باشد.`,
      );
    }

    // A public object needs somewhere public to be read from. Refusing here
    // rather than at read time means a deployment with no public base URL
    // fails on the first upload attempt with a clear message, instead of
    // accumulating objects whose URLs 403 for every visitor.
    if (policy.accessClass === 'public' && this.storage.publicUrl('probe') === null) {
      throw new MediaRejectedException(
        'بارگذاری تصویر در این محیط پیکربندی نشده است.',
        'MEDIA_PUBLIC_STORAGE_UNCONFIGURED',
      );
    }

    const stored = await this.objects.count({
      where: { ownerUserId, purpose: input.purpose, status: 'stored' },
    });
    if (stored >= policy.perUserQuota) {
      throw new MediaQuotaExceededException('به سقف تعداد تصاویر مجاز رسیده‌اید. ابتدا یکی را حذف کنید.');
    }

    const pending = await this.objects.count({ where: { ownerUserId, status: 'pending' } });
    if (pending >= MAX_PENDING_GRANTS_PER_USER) {
      throw new MediaQuotaExceededException('چند بارگذاری ناتمام دارید. ابتدا آن‌ها را کامل کنید.');
    }

    const id = uuidv7();
    // The key embeds the access class as its first segment, so a bucket
    // policy can be written against a prefix rather than against a list of
    // ids -- and so a misfiled object is visible by inspection. `uuidv7()` is
    // the unguessable part; nothing about the key is derived from the
    // uploader's filename (§8: "never derived from the original filename").
    const objectKey = `${policy.accessClass}/${input.purpose}/${id}`;

    await this.objects.insert({
      id,
      ownerUserId,
      purpose: input.purpose,
      accessClass: policy.accessClass,
      status: 'pending',
      storageDriver: this.storage.key,
      storageKey: objectKey,
      declaredContentType: input.contentType,
      declaredByteSize: input.byteSize,
      contentType: null,
      byteSize: null,
      width: null,
      height: null,
      finalizedAt: null,
      deletedAt: null,
      takenDownBy: null,
    });

    const upload = await this.storage.createUploadTarget({
      objectKey,
      contentType: input.contentType,
      declaredByteSize: input.byteSize,
      expiresInSeconds: UPLOAD_GRANT_TTL_SECONDS,
      accessClass: policy.accessClass,
    });

    return { mediaId: id, upload };
  }

  // --------------------------------------------------------------- finalize

  /**
   * Confirms an upload actually landed, and that what landed is acceptable.
   *
   * Idempotent: finalizing an already-`stored` object returns it unchanged,
   * because a client that retries after a dropped response has done nothing
   * wrong.
   *
   * Every rejection DELETES the object before it returns. An object that
   * failed validation but stayed in the bucket is storage the platform pays
   * for, cannot see, and would restore from a backup.
   */
  async finalize(ownerUserId: string, mediaId: string): Promise<MediaObjectEntity> {
    const row = await this.objects.findOne({ where: { id: mediaId } });
    if (!row || row.ownerUserId !== ownerUserId || row.status === 'deleted') {
      throw new MediaNotFoundOrNotYoursException();
    }
    if (row.status === 'stored') return row;

    const policy = MEDIA_POLICY[row.purpose];
    const head = await this.storage.head(row.storageKey);
    if (!head.exists) {
      throw new MediaRejectedException('فایلی بارگذاری نشده است.', 'MEDIA_NOT_UPLOADED');
    }

    const byteSize = head.byteSize ?? 0;
    if (byteSize <= 0 || byteSize > policy.maxBytes) {
      await this.discard(row, 'size');
      throw new MediaRejectedException(
        `حجم فایل باید حداکثر ${Math.floor(policy.maxBytes / (1024 * 1024))} مگابایت باشد.`,
      );
    }

    // The sniff. Deliberately a RANGE read: a finalize path that pulls whole
    // objects into memory is a denial-of-service primitive on a route any
    // authenticated user can call, and the header is all that is needed.
    const header = await this.storage.readRange(row.storageKey, 0, Math.min(IMAGE_PROBE_BYTES, byteSize) - 1);
    const probed = probeImage(header);
    if (!probed) {
      await this.discard(row, 'content-type');
      throw new MediaRejectedException('فایل ارسالی یک تصویر معتبر نیست.');
    }
    if (probed.width < policy.minEdgePx || probed.height < policy.minEdgePx) {
      await this.discard(row, 'too-small');
      throw new MediaRejectedException(`ابعاد تصویر باید حداقل ${policy.minEdgePx} پیکسل باشد.`);
    }
    if (probed.width > policy.maxEdgePx || probed.height > policy.maxEdgePx) {
      await this.discard(row, 'too-large');
      throw new MediaRejectedException(`ابعاد تصویر باید حداکثر ${policy.maxEdgePx} پیکسل باشد.`);
    }

    // Compare-and-swap on `pending`. Two concurrent finalizes for one object
    // must produce one transition; without this the second would rewrite
    // `finalized_at` on an object another request had already published.
    const claimed = await this.objects
      .createQueryBuilder()
      .update(MediaObjectEntity)
      .set({
        status: 'stored',
        contentType: probed.format,
        byteSize,
        width: probed.width,
        height: probed.height,
        finalizedAt: () => 'now()',
      })
      .where('id = :id AND status = :pending', { id: mediaId, pending: 'pending' })
      .execute();

    if (claimed.affected !== 1) {
      const current = await this.objects.findOne({ where: { id: mediaId } });
      if (current?.status === 'stored') return current;
      throw new MediaNotFoundOrNotYoursException();
    }

    return this.objects.findOneOrFail({ where: { id: mediaId } });
  }

  /** Marks a failed upload deleted and removes its bytes. Never throws -- the caller is already refusing. */
  private async discard(row: MediaObjectEntity, why: string): Promise<void> {
    try {
      await this.storage.delete(row.storageKey);
    } catch (error) {
      this.logger.warn(`Could not delete rejected object ${row.id} (${why}): ${(error as Error).message}`);
    }
    await this.objects.update({ id: row.id }, { status: 'deleted', deletedAt: () => 'now()' });
  }

  // ------------------------------------------------------------ attachment

  /**
   * The claim a referencing domain makes before it may store a media id.
   *
   * `provider` calls this from inside its own transaction before writing a
   * portfolio item or an avatar reference. It is the single check that stops
   * the whole class of bug where one professional attaches another's upload:
   * ownership, status, and purpose are all re-derived here from the row,
   * never from what the request said.
   */
  async claimForAttachment(
    manager: EntityManager,
    ownerUserId: string,
    mediaId: string,
    expectedPurpose: MediaPurpose,
  ): Promise<MediaObjectEntity> {
    const row = await manager.getRepository(MediaObjectEntity).findOne({ where: { id: mediaId } });
    if (
      !row ||
      row.ownerUserId !== ownerUserId ||
      row.status !== 'stored' ||
      row.purpose !== expectedPurpose ||
      row.deletedAt !== null
    ) {
      throw new MediaNotFoundOrNotYoursException();
    }
    return row;
  }

  /**
   * The public view of a set of objects.
   *
   * Returns nothing for an object that is not `stored`, and a `null` url for
   * a protected one. Both are silent rather than an error: this is called
   * while assembling a profile, and a single removed image must not fail the
   * whole page.
   */
  async describe(manager: EntityManager | null, mediaIds: string[]): Promise<Map<string, MediaDescriptor>> {
    const ids = mediaIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return new Map();

    const repo = manager ? manager.getRepository(MediaObjectEntity) : this.objects;
    const rows = await repo.find({ where: { id: In(ids), status: 'stored' } });

    const out = new Map<string, MediaDescriptor>();
    for (const row of rows) {
      out.set(row.id, {
        id: row.id,
        // A protected object NEVER gets a URL from this method, whatever the
        // driver would produce. Protected content is reachable only through
        // `issueProtectedDownloadUrl`, which re-authorizes the viewer.
        url: row.accessClass === 'public' ? this.storage.publicUrl(row.storageKey) : null,
        contentType: row.contentType,
        width: row.width,
        height: row.height,
      });
    }
    return out;
  }

  /**
   * Marks an object the caller owns as deleted, INSIDE the caller's
   * transaction. Returns the row so the caller can purge its bytes after the
   * commit.
   *
   * Deliberately split from the byte removal. A referencing domain deletes a
   * portfolio item and its object in one transaction, and if that transaction
   * rolls back the item must come back intact -- which it cannot if the bytes
   * were already gone. Row first, inside; bytes second, outside; never the
   * other way round.
   */
  async markDeletedOwned(
    manager: EntityManager,
    ownerUserId: string,
    mediaId: string,
  ): Promise<MediaObjectEntity> {
    const row = await this.markDeletedOwnedIfLive(manager, ownerUserId, mediaId);
    if (!row) throw new MediaNotFoundOrNotYoursException();
    return row;
  }

  /**
   * The same thing, but "it was already gone" is an answer rather than a
   * failure. Returns `null` in that case.
   *
   * This exists because of a real, reachable dead end. A moderator upholding
   * an abuse report marks the media object `deleted` while the portfolio item
   * referencing it survives with `media: null`. With only the throwing
   * variant, the professional could then never remove that leftover item --
   * `removeItem` would refuse on the object, not the item -- and replacing a
   * taken-down avatar would fail the same way. The owner's ability to tidy up
   * after a takedown must not depend on the object still existing.
   *
   * Ownership is still checked: a `null` here means "gone or not yours", and
   * the caller decides which of those is acceptable for its own operation.
   */
  async markDeletedOwnedIfLive(
    manager: EntityManager,
    ownerUserId: string,
    mediaId: string,
  ): Promise<MediaObjectEntity | null> {
    const repo = manager.getRepository(MediaObjectEntity);
    const row = await repo.findOne({ where: { id: mediaId } });
    if (!row || row.ownerUserId !== ownerUserId) return null;
    if (row.status === 'deleted') return null;
    await repo.update({ id: mediaId }, { status: 'deleted', deletedAt: () => 'now()' });
    return row;
  }

  /**
   * Removes the bytes of objects whose rows are already marked deleted.
   *
   * Best-effort by design: the reference is already gone from the product, so
   * a store hiccup leaves an orphaned object -- an operational cleanup
   * problem, not a correctness one -- rather than failing a mutation the user
   * has already been told succeeded.
   */
  async purgeBytes(rows: Array<Pick<MediaObjectEntity, 'id' | 'storageKey'>>): Promise<void> {
    for (const row of rows) {
      try {
        await this.storage.delete(row.storageKey);
      } catch (error) {
        this.logger.warn(`Object ${row.id} row deleted but bytes remain: ${(error as Error).message}`);
      }
    }
  }

  // -------------------------------------------------- protected downloads

  /**
   * Mints a short-lived, unguessable download URL for a PROTECTED object.
   *
   * `V3_SECURITY_MODEL.md` §8, point by point:
   *   - the token is the authorization artifact, random by construction
   *     (HMAC over the tuple, not a sequential id);
   *   - it is carried IN THE URL, because the specific V2 bug §8 records is
   *     a protected download served to a GET-navigated `<a href>` tripping
   *     the framework's own cookie CSRF guard for the legitimate owner;
   *   - and it is NOT sufficient on its own: `resolveProtectedDownload`
   *     re-checks, on every request, that the viewer named in the token is
   *     still allowed to see this object.
   */
  issueProtectedDownloadUrl(baseUrl: string, mediaId: string, viewerUserId: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + PROTECTED_DOWNLOAD_TTL_SECONDS;
    const token = this.signDownloadToken(mediaId, viewerUserId, expiresAt);
    return `${baseUrl.replace(/\/+$/, '')}/v1/media/${mediaId}/content?token=${token}`;
  }

  private signDownloadToken(mediaId: string, viewerUserId: string, expiresAt: number): string {
    const body = Buffer.from(JSON.stringify({ m: mediaId, u: viewerUserId, e: expiresAt })).toString('base64url');
    const mac = createHmac('sha256', this.downloadTokenSecret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  /**
   * Verifies a download token AND re-authorizes its bearer, then returns the
   * bytes.
   *
   * The re-authorization is the whole point and it is deliberately done
   * against LIVE data: a moderator whose capability was revoked one minute
   * ago cannot open an evidence file with a token minted two minutes ago.
   */
  async resolveProtectedDownload(
    requestedMediaId: string,
    token: string,
    canView: (row: MediaObjectEntity, viewerUserId: string) => Promise<boolean>,
  ): Promise<{ row: MediaObjectEntity; body: Buffer }> {
    const parts = token.split('.');
    if (parts.length !== 2) throw new MediaNotFoundOrNotYoursException();

    const expected = createHmac('sha256', this.downloadTokenSecret).update(parts[0]).digest('base64url');
    const given = Buffer.from(parts[1], 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new MediaNotFoundOrNotYoursException();
    }

    let claims: { m: string; u: string; e: number };
    try {
      claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      throw new MediaNotFoundOrNotYoursException();
    }
    if (claims.e * 1000 <= Date.now()) throw new MediaNotFoundOrNotYoursException();

    // The path and the token must name the SAME object.
    //
    // The object served is resolved from the TOKEN, never from the path, so
    // this is not what stops one viewer reading another's file -- the token is
    // minted for one media id and one viewer, and the `canView` re-check below
    // is what enforces authorization. But without this equality the path
    // segment is decorative: a token for object B presented at object A's URL
    // returns B with a 200, and every log line, cache key, and error report
    // downstream then names the wrong object. Found by the suite asserting the
    // mismatch should be refused, which it should.
    if (claims.m !== requestedMediaId) throw new MediaNotFoundOrNotYoursException();

    const row = await this.objects.findOne({ where: { id: claims.m } });
    if (!row || row.status !== 'stored' || row.accessClass !== 'protected') {
      throw new MediaNotFoundOrNotYoursException();
    }

    if (!(await canView(row, claims.u))) throw new MediaNotFoundOrNotYoursException();

    return { row, body: await this.storage.read(row.storageKey) };
  }

  /** True when the user currently holds the capability, read live. Fails closed. */
  async viewerHasCapability(userId: string, capability: string): Promise<boolean> {
    if (!this.capabilities) return false;
    try {
      return await this.capabilities.hasCapability(userId, capability);
    } catch {
      return false;
    }
  }

  async findById(mediaId: string): Promise<MediaObjectEntity | null> {
    return this.objects.findOne({ where: { id: mediaId } });
  }

  /** The bytes of a PUBLIC object, for the local driver's own serving route. */
  async readPublicByKey(storageKey: string): Promise<{ row: MediaObjectEntity; body: Buffer }> {
    const row = await this.objects.findOne({ where: { storageKey } });
    if (!row || row.status !== 'stored' || row.accessClass !== 'public') {
      throw new MediaNotFoundOrNotYoursException();
    }
    return { row, body: await this.storage.read(row.storageKey) };
  }

  // --------------------------------------------------------- direct upload

  /**
   * Terminates an upload for a driver whose target points back at this API.
   *
   * Three independent checks, none of which the token alone can satisfy:
   * the token must verify and not have expired (the caller does that), the
   * row must still be `pending` and undeleted, and the body must not exceed
   * what was declared. The last one is where the local driver enforces the
   * size cap the S3 driver defers to finalize.
   */
  async acceptDirectUpload(objectKey: string, declaredBytes: number, body: Buffer): Promise<void> {
    if (!this.storage.acceptDirectUpload) {
      throw new MediaNotFoundOrNotYoursException();
    }
    const row = await this.objects.findOne({ where: { storageKey: objectKey } });
    if (!row || row.status !== 'pending') throw new MediaNotFoundOrNotYoursException();
    if (body.length > declaredBytes || body.length > MEDIA_POLICY[row.purpose].maxBytes) {
      throw new MediaRejectedException('حجم فایل بیش از مقدار اعلام‌شده است.');
    }
    await this.storage.acceptDirectUpload(objectKey, body);
  }

  // ---------------------------------------------------------- abuse reports

  async reportAbuse(input: {
    mediaId: string;
    reportedBy: string;
    reason: AbuseReportReason;
    note: string | null;
  }): Promise<MediaAbuseReportEntity> {
    const row = await this.objects.findOne({ where: { id: input.mediaId } });
    // Only PUBLIC, stored objects are reportable. Accepting a report against
    // a protected id would confirm that the id exists to somebody who by
    // definition cannot see it.
    if (!row || row.status !== 'stored' || row.accessClass !== 'public') {
      throw new MediaNotFoundOrNotYoursException();
    }

    const report = this.reports.create({
      id: uuidv7(),
      mediaObjectId: input.mediaId,
      reportedBy: input.reportedBy,
      reason: input.reason,
      note: input.note,
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
    });
    await this.reports.save(report);
    return report;
  }

  async abuseQueue(params: { page: number; limit: number }): Promise<{ items: MediaAbuseReportEntity[]; total: number }> {
    const [items, total] = await this.reports.findAndCount({
      where: { status: 'open', decidedAt: IsNull() },
      order: { createdAt: 'ASC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
    return { items, total };
  }

  /**
   * A moderator decides a report.
   *
   * `uphold` takes the object down: the row is marked deleted, the bytes are
   * removed, and every profile referencing it stops rendering it. The
   * decision, the takedown, and the audit record are ONE transaction --
   * GAP-02-V3's property, applied to a mutation that removes somebody else's
   * content, which is exactly the kind that must never be unattributable.
   */
  async decideAbuseReport(input: {
    reportId: string;
    decision: 'uphold' | 'reject';
    actorUserId: string;
    reason: string;
  }): Promise<MediaAbuseReportEntity> {
    const takenDown = await this.dataSource.transaction(async (manager) => {
      const reportRepo = manager.getRepository(MediaAbuseReportEntity);
      const report = await reportRepo.findOne({ where: { id: input.reportId } });
      if (!report) throw new MediaNotFoundOrNotYoursException();

      const claimed = await manager
        .createQueryBuilder()
        .update(MediaAbuseReportEntity)
        .set({
          status: input.decision === 'uphold' ? 'upheld' : 'rejected',
          decidedBy: input.actorUserId,
          decidedAt: () => 'now()',
          decisionReason: input.reason,
        })
        .where('id = :id AND status = :open', { id: input.reportId, open: 'open' })
        .execute();
      if (claimed.affected !== 1) {
        throw new MediaRejectedException('این گزارش پیش‌تر بررسی شده است.', 'CONFLICT');
      }

      let removed: MediaObjectEntity | null = null;
      if (input.decision === 'uphold') {
        removed = await manager.getRepository(MediaObjectEntity).findOne({ where: { id: report.mediaObjectId } });
        if (removed && removed.status === 'stored') {
          await manager
            .getRepository(MediaObjectEntity)
            .update({ id: removed.id }, { status: 'deleted', deletedAt: () => 'now()', takenDownBy: input.actorUserId });
        }
      }

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: input.decision === 'uphold' ? 'media.abuse_report_upheld' : 'media.abuse_report_rejected',
        targetType: 'media_object',
        targetId: report.mediaObjectId,
        before: { status: 'stored', reportStatus: 'open' },
        after: { status: input.decision === 'uphold' ? 'deleted' : 'stored', reportId: input.reportId },
        reason: input.reason,
      });

      return removed;
    });

    // Outside the transaction, for the same reason `deleteOwned` does it: the
    // reference is already gone, and a store hiccup must not undo a
    // moderation decision that is already audited.
    if (takenDown) {
      try {
        await this.storage.delete(takenDown.storageKey);
      } catch (error) {
        this.logger.warn(`Taken-down object ${takenDown.id} bytes remain: ${(error as Error).message}`);
      }
    }

    return this.reports.findOneOrFail({ where: { id: input.reportId } });
  }

  // ------------------------------------------------------------- reaping

  /**
   * Removes `pending` rows whose grant expired without an upload.
   *
   * Without this, quota's pending-grant limit becomes a permanent lockout for
   * a user whose upload failed: `MAX_PENDING_GRANTS_PER_USER` abandoned rows
   * and they can never request another grant. Called by the same sweep
   * scheduler that drains outboxes and expires booking holds.
   */
  async reapExpiredGrants(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - UPLOAD_GRANT_TTL_SECONDS * 1000);
    const stale = await this.objects.find({ where: { status: 'pending', createdAt: LessThan(cutoff) }, take: 200 });

    let reaped = 0;
    for (const row of stale) {
      // Mark first, delete bytes second: a partially-uploaded object whose
      // row survived would be counted against a pending limit forever.
      const claimed = await this.objects
        .createQueryBuilder()
        .update(MediaObjectEntity)
        .set({ status: 'deleted', deletedAt: () => 'now()' })
        .where('id = :id AND status = :pending', { id: row.id, pending: 'pending' })
        .execute();
      if (claimed.affected !== 1) continue;
      reaped += 1;
      try {
        await this.storage.delete(row.storageKey);
      } catch {
        // An expired grant that was never uploaded has nothing to delete.
      }
    }
    return reaped;
  }
}
