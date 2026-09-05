import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { DomainException } from '@beauclick/http';
import { AdminAuditService } from '@beauclick/audit';
import { CapabilityEntity, RoleCapabilityEntity, RoleEntity, UserRoleEntity } from '../entities/role.entities';
import { UserEntity } from '../entities/user.entity';
import {
  AUDIT_TARGET_USER_ROLE,
  OWNER_ROLE_AUDIT_ACTIONS,
  OWNER_ROLE_AUDIT_REASONS,
  OWNER_ROLE_SYSTEM_ACTOR_LABEL,
  OwnerRoleSlug,
} from './owner-role.audit';

export class RoleNotFoundException extends DomainException {
  constructor() {
    super('VALIDATION_ERROR', 'نقش انتخاب‌شده معتبر نیست.', HttpStatus.BAD_REQUEST);
  }
}

export class RoleNotGrantableException extends DomainException {
  constructor(message = 'اعطای این نقش از این مسیر مجاز نیست.') {
    super('FORBIDDEN', message, HttpStatus.FORBIDDEN);
  }
}

export class SelfEscalationException extends DomainException {
  constructor() {
    super('FORBIDDEN', 'اعطای نقش مدیریتی به حساب خودتان مجاز نیست.', HttpStatus.FORBIDDEN);
  }
}

export class TargetUserNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export interface ResolvedAccess {
  roles: string[];
  capabilities: string[];
}

/**
 * Role assignment and capability resolution, from the database.
 *
 * THE ESCALATION RULES, in one place so they are arguable rather than
 * scattered:
 *
 *  1. Granting any role requires `bc_manage_platform`. The guard enforces the
 *     capability; this service enforces everything below it.
 *  2. **A caller may only grant a role whose capabilities are a SUBSET of
 *     their own.** You cannot give away authority you do not have. One rule,
 *     computed from the data, rather than a hand-maintained "who may grant
 *     what" matrix that would be one more thing to get wrong.
 *
 *     The first draft of this rule was narrower -- "may only grant a role you
 *     yourself hold" -- and it deadlocked: `moderator` holds
 *     `bc_moderate_reviews`, which `platform_operator` deliberately does not,
 *     so no operator could ever grant it, and a moderator has no
 *     `bc_manage_platform` and so cannot reach this endpoint at all. The role
 *     would have been permanently ungrantable. Caught by the test suite, not
 *     by review.
 *
 *     Under the subset rule the hierarchy is coherent: an administrator's
 *     capability set contains a moderator's, so an administrator can appoint
 *     one; a platform_operator cannot, because they genuinely lack authority
 *     over a domain they are not responsible for. That refusal is the rule
 *     working, not a gap.
 *  3. `administrator` is additionally never grantable through the application
 *     at all, even by an administrator. It exists for a deployment that
 *     genuinely needs it and is reachable only the way the first operator is:
 *     through the documented, audited bootstrap with database authority. This
 *     is V3_SECURITY_MODEL.md §9's "default new privileged accounts to the
 *     narrowest sufficient tier" taken at its word.
 *  4. No self-grant of a privileged role, ever. An operator who could widen
 *     their own authority is not an operator with bounded authority.
 *
 * Every grant and revoke writes an audit row IN THE SAME TRANSACTION. If the
 * audit insert fails, the grant fails with it.
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RoleEntity) private readonly roles: Repository<RoleEntity>,
    @InjectRepository(CapabilityEntity) private readonly capabilities: Repository<CapabilityEntity>,
    @InjectRepository(RoleCapabilityEntity) private readonly roleCapabilities: Repository<RoleCapabilityEntity>,
    @InjectRepository(UserRoleEntity) private readonly userRoles: Repository<UserRoleEntity>,
    private readonly audit: AdminAuditService,
  ) {}

  /** Roles that may never be granted through an HTTP route, whoever is asking. */
  private static readonly NEVER_GRANTABLE_VIA_API = ['administrator'];

  async listRoles(): Promise<RoleEntity[]> {
    return this.roles.find({ order: { slug: 'ASC' } });
  }

  async listCapabilities(): Promise<CapabilityEntity[]> {
    return this.capabilities.find({ order: { slug: 'ASC' } });
  }

  async rolesForUser(userId: string, manager?: EntityManager): Promise<string[]> {
    const repo = manager ? manager.getRepository(UserRoleEntity) : this.userRoles;
    const rows = await repo.find({ where: { userId } });
    return rows.map((r) => r.roleSlug).sort();
  }

  /**
   * The session's full access, resolved from the database.
   *
   * This is what `capabilitiesForRoles()` used to answer from a code constant.
   * The function still exists and is still the shape every guard consumes --
   * only the data's origin changed.
   */
  async resolveAccess(userId: string, manager?: EntityManager): Promise<ResolvedAccess> {
    const roles = await this.rolesForUser(userId, manager);
    if (roles.length === 0) return { roles: [], capabilities: [] };

    const repo = manager ? manager.getRepository(RoleCapabilityEntity) : this.roleCapabilities;
    const links = await repo.find({ where: { roleSlug: In(roles) } });
    const capabilities = Array.from(new Set(links.map((l) => l.capabilitySlug))).sort();
    return { roles, capabilities };
  }

  /** The capabilities one role confers. */
  async capabilitiesForRole(roleSlug: string, manager?: EntityManager): Promise<string[]> {
    const repo = manager ? manager.getRepository(RoleCapabilityEntity) : this.roleCapabilities;
    const links = await repo.find({ where: { roleSlug } });
    return links.map((l) => l.capabilitySlug).sort();
  }

  /** True when the user currently holds the capability, read live rather than from a token. */
  async hasCapability(userId: string, capability: string): Promise<boolean> {
    const { capabilities } = await this.resolveAccess(userId);
    return capabilities.includes(capability);
  }

  /** The default role every new account receives, read from the data rather than hardcoded. */
  async defaultRoleSlug(manager?: EntityManager): Promise<string> {
    const repo = manager ? manager.getRepository(RoleEntity) : this.roles;
    const row = await repo.findOne({ where: { isDefault: true } });
    // A database with no default role is a misconfiguration, not a runtime
    // condition to paper over: every account needs one.
    if (!row) throw new RoleNotFoundException();
    return row.slug;
  }

  /**
   * Assigns the default role to a brand-new account.
   *
   * Called inside account creation's own transaction, so a user row can never
   * exist without its role.
   */
  async assignDefaultRole(manager: EntityManager, userId: string): Promise<string[]> {
    const slug = await this.defaultRoleSlug(manager);
    await manager
      .getRepository(UserRoleEntity)
      .insert({ userId, roleSlug: slug, grantedBy: null, reason: 'default role at account creation' });
    return [slug];
  }

  /**
   * Grants a seller OWNER role inside the caller's transaction (`V33-DEC-021`).
   *
   * ## Why this is not `grant()`
   *
   * `grant()` is the administrator surface: it opens its own transaction,
   * requires a human actor, enforces the escalation rules, and writes an audit
   * row naming that human. Every one of those is wrong here.
   *
   * This path has no human actor — a role is granted because a seller created a
   * workspace, and `V33-DEC-018`/`V33-DEC-021` both forbid fabricating one. It
   * must also join the CALLER's transaction rather than opening its own, so the
   * ownership row and its role commit together or not at all. A method that
   * opened `this.dataSource.transaction` here would produce exactly the window
   * `V33-DEC-021` Ruling 8 forbids: committed ownership with no role, or a role
   * for ownership that rolled back.
   *
   * So it is a second, narrower method rather than a widening of the first, and
   * the two must not be merged: they are correct in different ways.
   *
   * ## The role is not a parameter the domain chooses freely
   *
   * `OwnerRoleSlug` admits `professional` and `business` and nothing else, and
   * the composition-root adapters bind one fixed value each. There is no shape
   * in this signature that could carry `administrator`, so escalation through
   * this path is not something a check could fail to catch — it is
   * unrepresentable.
   *
   * ## `customer` is never touched
   *
   * There is no delete, no replace and no `set`. The insert is additive and the
   * denormalized column is recomputed from `user_roles` afterwards, so the
   * default role survives by construction rather than by remembering to keep it
   * (`V33-DEC-021` Ruling 4).
   *
   * ## Idempotent, and the audit follows the INSERT rather than the intent
   *
   * `ON CONFLICT DO NOTHING` makes a replayed creation a no-op. The audit row is
   * written only when a row was actually inserted, so a retry does not inflate
   * the trail — which is why this returns the boolean rather than `void`.
   *
   * @returns `true` when a role row was created, `false` when the user already held it.
   */
  async assignOwnerRole(
    manager: EntityManager,
    userId: string,
    roleSlug: OwnerRoleSlug,
  ): Promise<boolean> {
    // Resolved from the DATA, never assumed. A deployment whose roles table is
    // missing `professional` is a misconfiguration, and failing here fails the
    // whole ownership transaction rather than creating a seller the platform
    // cannot authorize.
    const role = await manager.getRepository(RoleEntity).findOne({ where: { slug: roleSlug } });
    if (!role) throw new RoleNotFoundException();

    const inserted = await manager
      .getRepository(UserRoleEntity)
      .createQueryBuilder()
      .insert()
      .values({
        userId,
        roleSlug: role.slug,
        // No granting human exists. `admin.admin_audit_log` carries the
        // provenance through `actor_label`; this column records that nobody
        // decided, which is the truth.
        grantedBy: null,
        reason:
          roleSlug === 'professional'
            ? OWNER_ROLE_AUDIT_REASONS.professionalOwnershipCreated
            : OWNER_ROLE_AUDIT_REASONS.businessOwnershipCreated,
      })
      .orIgnore()
      .execute();

    // `orIgnore()` reports zero identifiers when the row already existed. That
    // is the whole idempotency signal, and it is read from the database rather
    // than from a prior SELECT that another transaction could invalidate
    // between the check and the write.
    const created = (inserted.identifiers?.length ?? 0) > 0;
    if (!created) return false;

    // The legacy denormalized column, kept in sync during the expand window
    // (ADR-016), recomputed from the authority rather than appended to.
    const after = await this.rolesForUser(userId, manager);
    await manager.getRepository(UserEntity).update({ id: userId }, { roles: after });

    await this.audit.recordSystem(manager, {
      actorLabel: OWNER_ROLE_SYSTEM_ACTOR_LABEL,
      action:
        roleSlug === 'professional'
          ? OWNER_ROLE_AUDIT_ACTIONS.professionalGranted
          : OWNER_ROLE_AUDIT_ACTIONS.businessGranted,
      targetType: AUDIT_TARGET_USER_ROLE,
      targetId: userId,
      after: { roles: after.join(','), role: role.slug },
      reason:
        roleSlug === 'professional'
          ? OWNER_ROLE_AUDIT_REASONS.professionalOwnershipCreated
          : OWNER_ROLE_AUDIT_REASONS.businessOwnershipCreated,
    });

    return true;
  }

  async grant(input: {
    actorUserId: string;
    targetUserId: string;
    roleSlug: string;
    reason: string;
  }): Promise<ResolvedAccess> {
    return this.mutate({ ...input, mode: 'grant' });
  }

  async revoke(input: {
    actorUserId: string;
    targetUserId: string;
    roleSlug: string;
    reason: string;
  }): Promise<ResolvedAccess> {
    return this.mutate({ ...input, mode: 'revoke' });
  }

  private async mutate(input: {
    actorUserId: string;
    targetUserId: string;
    roleSlug: string;
    reason: string;
    mode: 'grant' | 'revoke';
  }): Promise<ResolvedAccess> {
    return this.dataSource.transaction(async (manager) => {
      const role = await manager.getRepository(RoleEntity).findOne({ where: { slug: input.roleSlug } });
      if (!role) throw new RoleNotFoundException();

      if (RoleService.NEVER_GRANTABLE_VIA_API.includes(role.slug)) {
        throw new RoleNotGrantableException(
          'نقش «مدیر ارشد» از مسیر برنامه قابل اعطا یا لغو نیست و تنها از طریق فرایند راه‌اندازی مستند انجام می‌شود.',
        );
      }

      // The target must be a real user. Checked against the table rather than
      // trusted from the path, so a forged id is a 404 and not a row created
      // for a user that does not exist.
      const target = await manager.getRepository(UserEntity).findOne({ where: { id: input.targetUserId } });
      if (!target) throw new TargetUserNotFoundException();

      if (role.isPrivileged && input.actorUserId === input.targetUserId) {
        throw new SelfEscalationException();
      }

      // Rule 2: you cannot give away authority you do not have.
      //
      // Resolved inside the transaction from the DATABASE, never from the
      // caller's token -- a token is a snapshot, and an operator whose own role
      // was revoked a minute ago must not still be able to hand it out.
      if (role.isPrivileged) {
        const actorAccess = await this.resolveAccess(input.actorUserId, manager);
        const granted = await this.capabilitiesForRole(role.slug, manager);
        const missing = granted.filter((c) => !actorAccess.capabilities.includes(c));
        if (missing.length > 0) {
          throw new RoleNotGrantableException(
            `اعطای نقش «${role.name}» نیازمند دسترسی‌هایی است که حساب شما ندارد.`,
          );
        }
      }

      const before = await this.rolesForUser(input.targetUserId, manager);

      if (input.mode === 'grant') {
        await manager
          .getRepository(UserRoleEntity)
          .createQueryBuilder()
          .insert()
          .values({
            userId: input.targetUserId,
            roleSlug: role.slug,
            grantedBy: input.actorUserId,
            reason: input.reason,
          })
          // Idempotent: re-granting a role the user already holds is a no-op
          // rather than a unique-violation the caller has to interpret.
          .orIgnore()
          .execute();
      } else {
        await manager
          .getRepository(UserRoleEntity)
          .delete({ userId: input.targetUserId, roleSlug: role.slug });
      }

      const after = await this.rolesForUser(input.targetUserId, manager);

      // The legacy denormalized column, kept in sync during the expand window
      // (ADR-016). Nothing reads it any more, but dropping a column in the same
      // migration that introduces its replacement is the deploy-ordering hazard
      // the discipline exists to prevent.
      await manager.getRepository(UserEntity).update({ id: input.targetUserId }, { roles: after });

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: input.mode === 'grant' ? 'identity.role_granted' : 'identity.role_revoked',
        targetType: 'user',
        targetId: input.targetUserId,
        before: { roles: before.join(',') },
        after: { roles: after.join(','), role: role.slug },
        reason: input.reason,
      });

      return this.resolveAccess(input.targetUserId, manager);
    });
  }
}
