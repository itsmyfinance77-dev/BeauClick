import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';

import { Public, RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult, SkipResponseEnvelope } from '@beauclick/http';

import { MediaNotFoundOrNotYoursException, MediaRejectedException, MediaService } from './media.service';
import { ALLOWED_DECLARED_CONTENT_TYPES, MEDIA_PURPOSES, MediaPurpose } from './media-policy';
import { ABUSE_REPORT_REASONS, AbuseReportReason } from './entities/media-abuse-report.entity';
import { InvalidUploadTokenError, verifyUploadToken } from './storage/upload-grant.token';

export class RequestUploadDto {
  @IsIn(MEDIA_PURPOSES as unknown as string[])
  purpose!: MediaPurpose;

  @IsIn(ALLOWED_DECLARED_CONTENT_TYPES as unknown as string[])
  contentType!: string;

  @IsInt()
  @Min(1)
  // A ceiling above every per-purpose cap, so an absurd declaration is
  // refused by validation before it reaches the policy table at all.
  @Max(32 * 1024 * 1024)
  byteSize!: number;
}

export class ReportMediaDto {
  @IsIn(ABUSE_REPORT_REASONS as unknown as string[])
  reason!: AbuseReportReason;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;
}

export class DecideAbuseReportDto {
  @IsIn(['uphold', 'reject'])
  decision!: 'uphold' | 'reject';

  @IsString()
  @Length(4, 500)
  reason!: string;
}

/**
 * The media surface.
 *
 * Every mutating route derives the owner from the session. There is no owner,
 * professional, or business parameter anywhere on this controller, so
 * "upload on somebody else's behalf" is not a request this API can express --
 * the same property the verification controller has, and for the same reason.
 */
@Controller('v1/media')
export class MediaController {
  private readonly uploadTokenSecret: string;

  constructor(
    private readonly media: MediaService,
    config: ConfigService,
  ) {
    this.uploadTokenSecret =
      config.get<string>('MEDIA_UPLOAD_TOKEN_SECRET') ??
      config.get<string>('JWT_ACCESS_SECRET') ??
      'dev-only-insecure-media-secret';
  }

  @Post('upload-url')
  async requestUpload(@Body() dto: RequestUploadDto, @CurrentUser() user: AuthenticatedUser) {
    const grant = await this.media.createUploadGrant(user.userId, {
      purpose: dto.purpose,
      contentType: dto.contentType,
      byteSize: dto.byteSize,
    });
    return {
      mediaId: grant.mediaId,
      upload: {
        url: grant.upload.url,
        method: grant.upload.method,
        headers: grant.upload.headers,
        expiresAt: grant.upload.expiresAt.toISOString(),
      },
    };
  }

  @Post(':id/finalize')
  async finalize(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const row = await this.media.finalize(user.userId, id);
    return {
      id: row.id,
      purpose: row.purpose,
      contentType: row.contentType,
      width: row.width,
      height: row.height,
      byteSize: row.byteSize,
    };
  }

  /**
   * The local driver's upload endpoint.
   *
   * `@Public()` because the TOKEN is the credential, not the session -- the
   * same reasoning a presigned S3 URL rests on. It is not weaker than the S3
   * path: the token authorizes exactly one object key, pins the content type
   * and declared size, expires, AND the media row must still be `pending`.
   *
   * On a deployment using the S3 driver this route answers 404, because
   * `MediaService.acceptDirectUpload` refuses when the driver terminates
   * uploads elsewhere. A route that half-worked on the wrong driver would be
   * a second, unaudited way into the object store.
   */
  @Public()
  @Put('upload/:token')
  @HttpCode(204)
  async directUpload(@Param('token') token: string, @Req() request: Request): Promise<void> {
    let claims;
    try {
      claims = verifyUploadToken(token, this.uploadTokenSecret, Date.now());
    } catch (error) {
      if (error instanceof InvalidUploadTokenError) throw new MediaNotFoundOrNotYoursException();
      throw error;
    }

    const body = await readBodyWithLimit(request, claims.n);
    await this.media.acceptDirectUpload(claims.k, claims.n, body);
  }

  /**
   * Serves a PUBLIC object from the local driver.
   *
   * Public by design: these are portfolio images and avatars, meant to be
   * seen by logged-out visitors on a profile page. The route still consults
   * the row, so a taken-down or not-yet-finalized object is a 404 rather than
   * bytes that happen to still be on disk.
   */
  @Public()
  @SkipResponseEnvelope()
  @Get('file/:accessClass/:purpose/:id')
  async servePublic(
    @Param('accessClass') accessClass: string,
    @Param('purpose') purpose: string,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    // The three segments ARE the object key. Reassembled rather than
    // wildcarded so the shape is checked by routing, and `readPublicByKey`
    // then refuses anything whose row is not `public` and `stored` -- a
    // `protected/...` key reaching this route is a 404, not a leak.
    const { row, body } = await this.media.readPublicByKey(`${accessClass}/${purpose}/${id}`);
    response
      .status(200)
      .setHeader('content-type', row.contentType ?? 'application/octet-stream')
      // Immutable: an object's bytes never change -- a replacement is a new
      // id -- so a long cache is correct rather than merely convenient.
      .setHeader('cache-control', 'public, max-age=31536000, immutable')
      /**
       * Overrides helmet's application-wide `same-origin` default, for THIS
       * route only.
       *
       * The web app and the API are separate origins (`:3100` and `:3099` in
       * development, and separate hosts in any real deployment), so an `<img>`
       * on a profile page is a cross-origin resource request. Helmet 7 sets
       * `Cross-Origin-Resource-Policy: same-origin` on every response, and a
       * browser refuses to render an image that carries it from another
       * origin -- so every portfolio image and every avatar would silently
       * fail to load while the request itself returned 200.
       *
       * Narrowed to this handler rather than relaxed globally: these bytes are
       * public by design and immutable, which is exactly the case the
       * `cross-origin` value exists for. Every other response, and in
       * particular `GET /v1/media/:id/content`, keeps the strict default.
       */
      .setHeader('cross-origin-resource-policy', 'cross-origin')
      .send(body);
  }

  /**
   * Serves a PROTECTED object to an authorized viewer.
   *
   * `@Public()` at the guard level and NOT unauthenticated: the token names
   * the viewer, and `resolveProtectedDownload` re-checks that viewer's
   * authorization against live data on every single request
   * (`V3_SECURITY_MODEL.md` §8). Ambient cookie auth is deliberately not
   * relied on here -- §8 records the real V2 bug where a GET-navigated
   * protected download tripped the framework's own CSRF guard for the
   * legitimate owner.
   *
   * `canView` is supplied by the caller of the service, not decided here, so
   * each protected purpose states its own rule rather than inheriting a
   * generic one.
   */
  @Public()
  @SkipResponseEnvelope()
  @Get(':id/content')
  async serveProtected(
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    if (!token) throw new MediaNotFoundOrNotYoursException();

    const { row, body } = await this.media.resolveProtectedDownload(id, token, async (object, viewerUserId) => {
      // The owner may always read back what they submitted.
      if (object.ownerUserId === viewerUserId) return true;
      // Verification evidence is submitted FOR review, so the reviewer must
      // be able to open it -- that is the purpose of the submission, and it
      // is a different thing from an admin browsing somebody's private
      // archive, which §8 forbids and which Phase E's privacy exports will
      // continue to forbid.
      if (object.purpose === 'verification_evidence') {
        return this.media.viewerHasCapability(viewerUserId, 'bc_moderate_verification');
      }
      return false;
    });

    response
      .status(200)
      .setHeader('content-type', row.contentType ?? 'application/octet-stream')
      // Never cached by a shared cache. A protected object behind a
      // short-lived URL that a proxy stored is a protected object that leaked.
      .setHeader('cache-control', 'private, no-store')
      .send(body);
  }

  @Post(':id/report')
  @HttpCode(201)
  async report(@Param('id') id: string, @Body() dto: ReportMediaDto, @CurrentUser() user: AuthenticatedUser) {
    const row = await this.media.reportAbuse({
      mediaId: id,
      reportedBy: user.userId,
      reason: dto.reason,
      note: dto.note?.trim() || null,
    });
    return { id: row.id, status: row.status };
  }
}

/**
 * The moderation queue for reported media.
 *
 * Gated on `bc_moderate_media`, a NEW capability rather than a reuse of
 * `bc_moderate_verification`. The two are different authorities over
 * different things: deciding whether a professional is who they claim to be
 * is the operational tier's work, while removing somebody's published work
 * from the marketplace is content moderation. Reusing the verification
 * capability would have handed every platform operator takedown authority as
 * a side effect of being able to approve a verification -- exactly the
 * conflation `V3_SECURITY_MODEL.md` §9 asks to avoid, and the same reasoning
 * the roles migration already recorded for `bc_moderate_reviews`.
 */
@Controller('v1/admin/media')
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @RequireCapability('bc_moderate_media')
  @Get('reports')
  async queue(@Query() query: PageQueryDto): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.media.abuseQueue({ page: query.page, limit: query.limit });
    return {
      value: items.map((row) => ({
        id: row.id,
        mediaObjectId: row.mediaObjectId,
        reason: row.reason,
        note: row.note,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  @RequireCapability('bc_moderate_media')
  @AuditAction('media.abuse_report_decided')
  @Post('reports/:id/decide')
  async decide(
    @Param('id') id: string,
    @Body() dto: DecideAbuseReportDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Actor from the session, never the body.
    const row = await this.media.decideAbuseReport({
      reportId: id,
      decision: dto.decision,
      actorUserId: user.userId,
      reason: dto.reason,
    });
    return { id: row.id, status: row.status, decidedAt: row.decidedAt?.toISOString() ?? null };
  }
}

/**
 * Reads the request body, refusing anything past the declared size.
 *
 * Written by hand rather than through a body-parser middleware because the
 * limit is PER REQUEST -- it is whatever the signed grant said, not a global
 * constant -- and because a global raw-body parser registered for `image/*`
 * would buffer bodies for every route that ever receives one.
 *
 * The check is inside the data handler, so an oversized upload is cut off
 * mid-stream rather than after it has all been buffered. A limit enforced
 * after the fact is not a limit on memory.
 */
async function readBodyWithLimit(request: Request, limitBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;

    request.on('data', (chunk: Buffer) => {
      if (overLimit) return;
      total += chunk.length;
      if (total > limitBytes) {
        overLimit = true;
        // Stop BUFFERING, but keep draining. Destroying the socket here was
        // the first attempt and it is wrong: the client gets a connection
        // reset instead of a diagnosable 400, and an uploader cannot tell a
        // rejected file from a broken network. Discarding the remainder keeps
        // memory bounded -- which is the actual goal -- while leaving the
        // connection healthy enough to carry the refusal back.
        chunks.length = 0;
        reject(new MediaRejectedException('حجم فایل بیش از مقدار اعلام‌شده است.'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}
