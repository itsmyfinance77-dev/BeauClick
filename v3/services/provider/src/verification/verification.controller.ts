import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { MediaService } from '@beauclick/media';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { AddVerificationEvidenceDto } from '../dto/portfolio.dto';
import { VerificationRequestEntity } from '../entities/verification-request.entity';
import { VerificationDecision, VerificationService } from './verification.service';

export class SubmitVerificationDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}

export class DecideVerificationDto {
  @IsIn(['approve', 'reject'])
  decision!: VerificationDecision;

  /** Required in both directions: an approval with no stated basis is as unhelpful as a rejection with none. */
  @IsString()
  @Length(4, 500)
  reason!: string;
}

function toRequestShape(row: VerificationRequestEntity) {
  return {
    id: row.id,
    professionalId: row.professionalId,
    status: row.status,
    note: row.note,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
  };
}

/**
 * The professional's own side of verification.
 *
 * No professional parameter anywhere on this controller: the professional is
 * resolved from the session, so "submit for somebody else" is not a request
 * this API can express.
 */
@Controller('v1/verification')
export class VerificationController {
  private readonly apiBaseUrl: string;

  constructor(
    private readonly verification: VerificationService,
    private readonly media: MediaService,
    config: ConfigService,
  ) {
    this.apiBaseUrl = (config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api').replace(/\/+$/, '');
  }

  @Post('submit')
  async submit(@Body() dto: SubmitVerificationDto, @CurrentUser() user: AuthenticatedUser) {
    const row = await this.verification.submit(user.userId, dto.note?.trim() || null);
    return toRequestShape(row);
  }

  /** `null` means "you have never submitted", which is an answer -- not a failure. */
  @Get('me')
  async mine(@CurrentUser() user: AuthenticatedUser) {
    const row = await this.verification.latestFor(user.userId);
    return row ? toRequestShape(row) : null;
  }

  /**
   * Attaches an already-uploaded, already-finalized PROTECTED media object to
   * the caller's open request.
   *
   * The media object must have been created with
   * `purpose: 'verification_evidence'`, which is what made it `protected` and
   * therefore unaddressable in public. That is re-derived from the media row,
   * not taken from this request.
   */
  @Post('evidence')
  @HttpCode(201)
  async addEvidence(@Body() dto: AddVerificationEvidenceDto, @CurrentUser() user: AuthenticatedUser) {
    const row = await this.verification.addEvidence(user.userId, dto.mediaId);
    return { id: row.id, mediaId: row.mediaId, createdAt: row.createdAt.toISOString() };
  }

  /**
   * The caller's own evidence, with download URLs they are authorized for.
   *
   * A submitter may always read back what they submitted -- otherwise they
   * cannot check that the right document went up.
   */
  @Get('me/evidence')
  async myEvidence(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.verification.myEvidence(user.userId);
    return rows.map((row) => ({
      id: row.id,
      mediaId: row.mediaId,
      downloadUrl: this.media.issueProtectedDownloadUrl(this.apiBaseUrl, row.mediaId, user.userId),
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

/**
 * The review queue.
 *
 * Gated on `bc_moderate_verification`, NOT on `bc_manage_platform`. The two are
 * different authorities and the migration's own seed comment explains why
 * `platform_operator` holds this one: reviewing verifications is the
 * operational tier's work, whereas review moderation (which the `moderator`
 * role also holds) is a domain that does not exist yet.
 */
@Controller('v1/admin/verification')
export class AdminVerificationController {
  private readonly apiBaseUrl: string;

  constructor(
    private readonly verification: VerificationService,
    private readonly media: MediaService,
    config: ConfigService,
  ) {
    this.apiBaseUrl = (config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api').replace(/\/+$/, '');
  }

  @RequireCapability('bc_moderate_verification')
  @Get('queue')
  async queue(@Query() query: PageQueryDto): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.verification.queue({ page: query.page, limit: query.limit });
    return {
      value: items.map((row) => ({ ...toRequestShape(row), displayName: row.displayName, cityId: row.cityId })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  /**
   * The evidence attached to one request, with a short-lived download URL per
   * document.
   *
   * The URL is minted for THIS moderator and re-authorized on every request
   * against live capability data -- a moderator whose authority is revoked one
   * minute from now cannot open a document with a URL minted today. Listing is
   * gated separately from reading, which is §8's "visibility of metadata and
   * access to raw content are different privilege levels" taken literally.
   *
   * WHY A MODERATOR MAY READ THIS AT ALL, given §8 also says a general
   * moderation capability must not confer downloading another user's private
   * files: verification evidence is submitted FOR review. Reviewing it is the
   * purpose of the submission and the professional knows that when they upload
   * it. That is a different thing from a privacy-export archive, which is
   * generated for the subject alone -- and Phase E must keep those
   * moderator-invisible, exactly as V2 did.
   */
  @RequireCapability('bc_moderate_verification')
  @Get(':id/evidence')
  async evidence(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const rows = await this.verification.evidenceForRequest(id);
    return rows.map((row) => ({
      id: row.id,
      mediaId: row.mediaId,
      downloadUrl: this.media.issueProtectedDownloadUrl(this.apiBaseUrl, row.mediaId, user.userId),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  @RequireCapability('bc_moderate_verification')
  @AuditAction('provider.verification_decided')
  @Post(':id/decide')
  async decide(
    @Param('id') id: string,
    @Body() dto: DecideVerificationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Actor from the session, never the body.
    const row = await this.verification.decide({
      requestId: id,
      decision: dto.decision,
      actorUserId: user.userId,
      reason: dto.reason,
    });
    return toRequestShape(row);
  }
}
