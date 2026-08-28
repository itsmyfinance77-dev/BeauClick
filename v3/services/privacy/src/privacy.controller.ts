import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Throttle } from '@nestjs/throttler';

import { policy, RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';

import { DataRequestEntity } from './entities/data-request.entity';
import { PrivacyService } from './privacy.service';

export class ErasureConfirmationDto {
  /**
   * A typed confirmation, required and required to be exact.
   *
   * Not theatre, and not a substitute for authentication -- the session
   * already proves who is asking. What it defends against is the one-tap
   * mistake: this is the single irreversible action a user can take against
   * their own account, and it must not be reachable by a mis-tap or by a CSRF
   * that guessed an empty body. The grace window is the second line; this is
   * the first.
   */
  @IsString()
  @IsIn(['DELETE'])
  confirm!: string;
}

export class PrivacyRequestQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(3, 16)
  status?: string;
}

function present(request: DataRequestEntity) {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    requestedAt: request.requestedAt,
    /** Erasure only: when the grace window closes. Null on an export. */
    executeAfter: request.executeAfter,
    /** Export only: when the document stops being downloadable. Null until it is generated. */
    expiresAt: request.expiresAt,
    completedAt: request.completedAt,
    cancelledAt: request.cancelledAt,
    failureCode: request.failureCode,
  };
}

/**
 * The subject's own privacy surface (`GAP-22`, `GAP-21`).
 *
 * **There is no user id anywhere in this controller.** Every route derives the
 * subject from `@CurrentUser()`, so "export somebody else's data" and "delete
 * somebody else's account" are requests this API cannot express -- the same
 * construction `/v1/me` uses, and the strongest available form of the
 * ownership rule: there is nothing to forge because there is no parameter.
 *
 * Rate limited on the write routes because both are expensive: an export
 * assembles a subject's entire data set across fourteen modules, and an
 * erasure request fans out a notification. Neither is a route anybody
 * legitimately calls in a loop.
 */
@Controller('v1/privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** Everything the caller has ever asked for, both kinds, newest first. */
  @Get('requests')
  async listOwn(@CurrentUser() user: AuthenticatedUser) {
    const requests = await this.privacy.listOwn(user.userId);
    return requests.map(present);
  }

  @Throttle(policy('auth'))
  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestExport(@CurrentUser() user: AuthenticatedUser) {
    // 202, not 201: the document does not exist yet. Returning 201 with a
    // request id that cannot be downloaded is how a client ends up polling a
    // resource it believes already exists.
    return present(await this.privacy.requestExport(user.userId));
  }

  @Get('export/:id')
  async exportStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return present(await this.privacy.findOwn(user.userId, id));
  }

  /**
   * The document itself.
   *
   * The only route in the platform that returns a complete personal-data
   * export, and it is reachable by exactly one principal: the subject, with a
   * live session, for their own request id, before it expires. There is no
   * signed URL, no token, and no administrative equivalent -- see the
   * migration header for why a presigned object-storage URL was rejected.
   */
  @Get('export/:id/download')
  async downloadExport(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const result = await this.privacy.downloadOwnExport(user.userId, id);
    return {
      byteSize: result.byteSize,
      checksumSha256: result.checksum,
      expiresAt: result.expiresAt,
      document: result.document,
    };
  }

  @Throttle(policy('auth'))
  @Post('deletion')
  @HttpCode(HttpStatus.ACCEPTED)
  // Self-service, so it carries no privileged capability and the boot
  // assertion does not require an audit action -- but it is recorded anyway.
  // `admin.admin_audit_log` is where "why does this account no longer exist"
  // is answered, and the answer must exist whether the actor was an operator
  // or the subject.
  @AuditAction('privacy.erasure_requested')
  async requestErasure(@CurrentUser() user: AuthenticatedUser, @Body() _dto: ErasureConfirmationDto) {
    return present(await this.privacy.requestErasure(user.userId));
  }

  @Get('deletion/:id')
  async erasureStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return present(await this.privacy.findOwn(user.userId, id));
  }

  /**
   * The way back out of the grace window.
   *
   * Deliberately NOT rate-limited the way the request routes are: somebody
   * trying repeatedly to cancel their own deletion is somebody the platform
   * should be helping, not throttling.
   */
  @Post('deletion/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @AuditAction('privacy.erasure_cancelled')
  async cancelErasure(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return present(await this.privacy.cancelErasure(user.userId, id));
  }
}

/**
 * The operator's view (`GET /v1/admin/privacy/requests`).
 *
 * Read-only, and read-only on purpose in two directions:
 *
 *   * It cannot reach a payload. Phase E's security note is unqualified --
 *     "no admin route may ever download another user's export file" -- and the
 *     schema makes it structural: the payload is not on the row this route
 *     reads.
 *   * It cannot cancel an erasure. An operator who can cancel a deletion can
 *     silently keep an account its owner asked to be rid of, and there is no
 *     legitimate operational need that outweighs that. If a request is stuck,
 *     the sweep's `failed` state and its stable failure code are what an
 *     operator acts on.
 *
 * Being read-only is also why it carries no `@AuditAction`: the boot assertion
 * covers privileged MUTATIONS, and this is a GET.
 */
@Controller('v1/admin/privacy')
export class AdminPrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @RequireCapability('bc_manage_platform')
  @Get('requests')
  async list(@Query() query: PrivacyRequestQueryDto): Promise<PaginatedResult<unknown[]>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const result = await this.privacy.listForOperator({ page, limit, status: query.status });
    return { value: result.items, meta: { pagination: { page, limit, total: result.total } } };
  }
}
