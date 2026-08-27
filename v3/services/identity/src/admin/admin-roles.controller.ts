import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsString, Length } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleService } from '../rbac/role.service';
import { ParseUuidPipeCompat } from './parse-uuid.pipe';
import { UserEntity } from '../entities/user.entity';

export class RoleMutationDto {
  @IsString()
  @Length(2, 40)
  roleSlug!: string;

  @IsIn(['grant', 'revoke'])
  operation!: 'grant' | 'revoke';

  /**
   * Required, and required to be substantive.
   *
   * An audit trail whose reason column is empty answers "what happened" and
   * not "why", and the second question is the one anybody reading it later
   * actually has. A 4-character minimum will not stop someone typing "asdf",
   * but it does stop the empty string being the path of least resistance.
   */
  @IsString()
  @Length(4, 500)
  reason!: string;
}

export class UserSearchDto extends PageQueryDto {
  @IsString()
  @Length(3, 32)
  phone!: string;
}

/**
 * Role administration.
 *
 * Every escalation rule lives in `RoleService`, not here -- a controller that
 * enforces authorization inline is a controller whose rules cannot be tested
 * without HTTP, and the rules are the interesting part. What this class is
 * responsible for is that **the actor is the session and never the request**.
 */
@Controller('v1/admin/users')
export class AdminRolesController {
  constructor(
    private readonly roles: RoleService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {}

  /**
   * Find a user to act on, by exact phone.
   *
   * Exact match, never a prefix or partial: a substring search over the user
   * table is a directory of everyone who has ever signed up, and an operator
   * granting a role already knows the number of the person they are granting
   * it to. The narrower tool is the correct one.
   */
  @RequireCapability('bc_manage_platform')
  @Get()
  async search(@Query() query: UserSearchDto): Promise<PaginatedResult<unknown[]>> {
    const normalized = query.phone.trim();
    const record = await this.users.findOne({ where: { phone: normalized } });
    const items = record
      ? [
          {
            id: record.id,
            phone: record.phone,
            displayName: record.displayName,
            roles: await this.roles.rolesForUser(record.id),
            createdAt: record.createdAt,
          },
        ]
      : [];
    return { value: items, meta: { pagination: { page: 1, limit: 1, total: items.length } } };
  }

  @RequireCapability('bc_manage_platform')
  @Get('roles/catalogue')
  async catalogue() {
    const [roles, capabilities] = await Promise.all([this.roles.listRoles(), this.roles.listCapabilities()]);
    return {
      roles: roles.map((r) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        isPrivileged: r.isPrivileged,
        isDefault: r.isDefault,
      })),
      capabilities: capabilities.map((c) => ({
        slug: c.slug,
        description: c.description,
        isPrivileged: c.isPrivileged,
      })),
    };
  }

  @RequireCapability('bc_manage_platform')
  @Get(':id/roles')
  async rolesFor(@Param('id', new ParseUuidPipeCompat()) id: string) {
    return this.roles.resolveAccess(id);
  }

  /**
   * Grant or revoke, in one route.
   *
   * Both directions share every guard, every validation, and the same audit
   * shape; splitting them into two handlers would duplicate all of that so the
   * URL could carry one bit of information the body already carries.
   */
  @RequireCapability('bc_manage_platform')
  @AuditAction('identity.role_granted')
  @Post(':id/roles')
  async mutate(
    @Param('id', new ParseUuidPipeCompat()) targetUserId: string,
    @Body() dto: RoleMutationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // The actor is the verified session, full stop. There is no actor field on
    // RoleMutationDto for a caller to supply, so attributing a grant to
    // somebody else is not something a check could fail to catch -- it is
    // unrepresentable.
    const input = {
      actorUserId: user.userId,
      targetUserId,
      roleSlug: dto.roleSlug,
      reason: dto.reason,
    };
    return dto.operation === 'grant' ? this.roles.grant(input) : this.roles.revoke(input);
  }
}
