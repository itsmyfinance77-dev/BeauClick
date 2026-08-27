import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AdminAuditService } from '@beauclick/audit';
import { PageQueryDto, PaginatedResult } from '@beauclick/http';

export class AuditLogQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  action?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  targetType?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  targetId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  actorUserId?: string;
}

/**
 * The audit log, read-only.
 *
 * There is deliberately no PATCH, PUT, or DELETE on this controller, and no
 * service method behind one either -- but the guarantee does not rest on that
 * absence. `admin.admin_audit_log` is owned by a role the application never
 * connects as, and the application holds INSERT + SELECT only, so a mutation
 * route added here in future would be refused by PostgreSQL rather than by
 * this class's restraint. An audit trail the audited party can edit is not an
 * audit trail.
 *
 * Reads are not audited. That is a stated boundary rather than an oversight:
 * auditing every read of the audit log produces a log dominated by people
 * looking at the log.
 */
@Controller('v1/admin/audit-log')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @RequireCapability('bc_manage_platform')
  @Get()
  async list(@Query() query: AuditLogQueryDto): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.audit.list({
      page: query.page,
      limit: query.limit,
      action: query.action,
      targetType: query.targetType,
      targetId: query.targetId,
      actorUserId: query.actorUserId,
    });

    return {
      value: items.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        actorLabel: row.actorLabel,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        // Bounded snapshots by construction (`AuditSnapshot` cannot express a
        // nested object), so there is no secret-bearing blob to redact here --
        // the constraint is enforced where the record is written, not by
        // filtering on the way out.
        before: row.beforeState,
        after: row.afterState,
        reason: row.reason,
        correlationId: row.correlationId,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  /** Real action names, so the filter is a picker rather than a guess-the-string box. */
  @RequireCapability('bc_manage_platform')
  @Get('actions')
  async actions() {
    return this.audit.knownActions();
  }
}
