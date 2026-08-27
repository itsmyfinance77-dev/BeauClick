import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { PhoneConflictService } from './phone-conflict.service';
import { ParseUuidPipeCompat } from './parse-uuid.pipe';

export class ConflictListDto extends PageQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeResolved?: boolean;
}

export class ResolveConflictDto {
  @IsString()
  @Length(4, 500)
  reason!: string;
}

/**
 * The phone-conflict review queue.
 *
 * ON WHAT IS SHOWN: a conflict row names a phone number and the id of the
 * account that already held it. The phone is the whole subject of the conflict
 * and cannot be withheld without making the queue useless, but the OTHER
 * user's details are not fetched or returned -- an id is enough to act on, and
 * joining the user table here would turn a narrow operational queue into a
 * general-purpose lookup of arbitrary accounts.
 */
@Controller('v1/admin/phone-conflicts')
export class AdminPhoneConflictsController {
  constructor(private readonly conflicts: PhoneConflictService) {}

  @RequireCapability('bc_manage_platform')
  @Get()
  async list(@Query() query: ConflictListDto): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.conflicts.list({
      page: query.page,
      limit: query.limit,
      includeResolved: query.includeResolved ?? false,
    });
    return {
      value: items.map((c) => ({
        id: c.id,
        phone: c.phone,
        existingUserId: c.existingUserId,
        note: c.note,
        resolvedAt: c.resolvedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  @RequireCapability('bc_manage_platform')
  @AuditAction('identity.phone_conflict_resolved')
  @Post(':id/resolve')
  async resolve(
    @Param('id', new ParseUuidPipeCompat()) id: string,
    @Body() dto: ResolveConflictDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const resolved = await this.conflicts.resolve({
      conflictId: id,
      actorUserId: user.userId,
      reason: dto.reason,
    });
    return {
      id: resolved.id,
      phone: resolved.phone,
      existingUserId: resolved.existingUserId,
      note: resolved.note,
      resolvedAt: resolved.resolvedAt?.toISOString() ?? null,
      createdAt: resolved.createdAt.toISOString(),
    };
  }
}
