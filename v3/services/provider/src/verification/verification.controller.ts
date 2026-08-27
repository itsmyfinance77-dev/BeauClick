import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
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
  constructor(private readonly verification: VerificationService) {}

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
  constructor(private readonly verification: VerificationService) {}

  @RequireCapability('bc_moderate_verification')
  @Get('queue')
  async queue(@Query() query: PageQueryDto): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.verification.queue({ page: query.page, limit: query.limit });
    return {
      value: items.map((row) => ({ ...toRequestShape(row), displayName: row.displayName, cityId: row.cityId })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
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
