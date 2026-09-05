import { EntityManager } from 'typeorm';

import { RoleService, RoleNotFoundException } from './role.service';
import {
  AUDIT_TARGET_USER_ROLE,
  OWNER_ROLE_AUDIT_ACTIONS,
  OWNER_ROLE_AUDIT_REASONS,
  OWNER_ROLE_MIGRATION_ACTOR_LABEL,
  OWNER_ROLE_SLUGS,
  OWNER_ROLE_SYSTEM_ACTOR_LABEL,
} from './owner-role.audit';
import { CAPABILITIES_BY_ROLE } from './capabilities';

/**
 * `RoleService.assignOwnerRole` at the fast layer — V3.3 #75, `V33-DEC-021`.
 *
 * ## What belongs here and what does not
 *
 * The real-PostgreSQL suite owns everything about ROWS: that ownership and role
 * commit together, that `ON CONFLICT DO NOTHING` arbitrates a race, that the
 * audit row lands in a table the application cannot rewrite. None of that is
 * observable without a real server.
 *
 * What is observable here is the DECISION LOGIC, and one property the pg suite
 * deliberately cannot reach: an audit failure must abort the grant.
 * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and the
 * application role holds INSERT and SELECT only, so the pg suite cannot plant a
 * failing constraint on it — and granting the test role that power would spend
 * the guarantee the role separation exists to provide. A throwing collaborator
 * here needs no privilege at all and proves exactly the same thing.
 */
describe('RoleService.assignOwnerRole', () => {
  interface Recorded {
    inserted: Array<Record<string, unknown>>;
    audited: Array<Record<string, unknown>>;
    userUpdates: Array<Record<string, unknown>>;
  }

  /**
   * A manager stubbed at the two shapes `assignOwnerRole` actually uses: the
   * role lookup, and the insert/update repositories.
   *
   * Hand-built rather than pg-mem, because the interesting behaviour is which
   * collaborator is called with what, in which order, and what happens when one
   * throws — and pg-mem would add a database without adding an assertion.
   */
  function managerFor(options: {
    roleExists?: boolean;
    insertedIdentifiers?: unknown[];
    recorded: Recorded;
  }): EntityManager {
    const { roleExists = true, insertedIdentifiers = [{ userId: 'u1', roleSlug: 'professional' }], recorded } = options;

    const insertBuilder = {
      insert: () => insertBuilder,
      values: (value: Record<string, unknown>) => {
        recorded.inserted.push(value);
        return insertBuilder;
      },
      orIgnore: () => insertBuilder,
      execute: async () => ({ identifiers: insertedIdentifiers }),
    };

    return {
      getRepository: (entity: { name: string }) => {
        if (entity.name === 'RoleEntity') {
          return {
            findOne: async ({ where }: { where: { slug: string } }) =>
              roleExists ? { slug: where.slug, name: where.slug, isPrivileged: false, isDefault: false } : null,
          };
        }
        if (entity.name === 'UserRoleEntity') {
          return {
            createQueryBuilder: () => insertBuilder,
            find: async () => [{ roleSlug: 'customer' }, { roleSlug: 'professional' }],
          };
        }
        if (entity.name === 'UserEntity') {
          return {
            update: async (criteria: unknown, patch: Record<string, unknown>) => {
              recorded.userUpdates.push({ criteria, patch });
            },
          };
        }
        throw new Error(`unexpected repository: ${entity.name}`);
      },
    } as unknown as EntityManager;
  }

  function serviceWith(audit: { recordSystem: jest.Mock<Promise<void>, [EntityManager, Record<string, unknown>]> }): RoleService {
    return new RoleService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      audit as never,
    );
  }

  type AuditSpy = { recordSystem: jest.Mock<Promise<void>, [EntityManager, Record<string, unknown>]> };

  function auditSpy(onCall?: () => void): AuditSpy {
    return {
      recordSystem: jest.fn(async (_manager: EntityManager, _payload: Record<string, unknown>) => {
        onCall?.();
      }),
    };
  }

  function freshRecorded(): Recorded {
    return { inserted: [], audited: [], userUpdates: [] };
  }

  it('inserts the role additively, with no granting human and a fixed server-owned reason', async () => {
    const recorded = freshRecorded();
    const audit = auditSpy();
    const service = serviceWith(audit);

    const created = await service.assignOwnerRole(managerFor({ recorded }), 'u1', 'professional');

    expect(created).toBe(true);
    expect(recorded.inserted).toEqual([
      {
        userId: 'u1',
        roleSlug: 'professional',
        // No fabricated actor. `admin.admin_audit_log.actor_label` carries the
        // provenance instead, and `ck_admin_audit_actor` enforces the pairing.
        grantedBy: null,
        reason: OWNER_ROLE_AUDIT_REASONS.professionalOwnershipCreated,
      },
    ]);
    // Nothing is deleted, replaced or `set` -- so `customer` cannot be lost.
    expect(JSON.stringify(recorded.inserted)).not.toMatch(/delete|remove/i);
  });

  it('audits a real insert exactly once, as the system actor', async () => {
    const recorded = freshRecorded();
    const audit = auditSpy();
    const service = serviceWith(audit);

    await service.assignOwnerRole(managerFor({ recorded }), 'u1', 'business');

    expect(audit.recordSystem).toHaveBeenCalledTimes(1);
    const [manager, payload] = audit.recordSystem.mock.calls[0];
    // The CALLER's manager, so the audit row shares the caller's transaction.
    expect(manager).toBeDefined();
    expect(payload).toMatchObject({
      actorLabel: OWNER_ROLE_SYSTEM_ACTOR_LABEL,
      action: OWNER_ROLE_AUDIT_ACTIONS.businessGranted,
      targetType: AUDIT_TARGET_USER_ROLE,
      targetId: 'u1',
      reason: OWNER_ROLE_AUDIT_REASONS.businessOwnershipCreated,
    });
    // No `actorUserId` field at all: `recordSystem`'s signature omits it, so a
    // human actor is unrepresentable here rather than merely unset.
    expect(payload).not.toHaveProperty('actorUserId');
  });

  it('writes nothing extra when the row already existed', async () => {
    const recorded = freshRecorded();
    const audit = auditSpy();
    const service = serviceWith(audit);

    // `orIgnore()` reports zero identifiers when the conflict target matched.
    const created = await service.assignOwnerRole(
      managerFor({ recorded, insertedIdentifiers: [] }),
      'u1',
      'professional',
    );

    expect(created).toBe(false);
    // A replay must not inflate the trail, and must not touch the denormalized
    // column either -- there is nothing new to denormalize.
    expect(audit.recordSystem).not.toHaveBeenCalled();
    expect(recorded.userUpdates).toEqual([]);
  });

  it('refuses when the role slug is absent from the catalogue, before writing anything', async () => {
    const recorded = freshRecorded();
    const audit = auditSpy();
    const service = serviceWith(audit);

    await expect(
      service.assignOwnerRole(managerFor({ recorded, roleExists: false }), 'u1', 'professional'),
    ).rejects.toBeInstanceOf(RoleNotFoundException);

    expect(recorded.inserted).toEqual([]);
    expect(audit.recordSystem).not.toHaveBeenCalled();
  });

  it('propagates an AUDIT failure, so the caller transaction aborts with the grant inside it', async () => {
    /*
     * The case the pg suite cannot run.
     *
     * `assignOwnerRole` awaits `recordSystem` on the caller's manager and does
     * not catch. So when the audit insert fails, the rejection travels out
     * through `ProviderService.create`'s `dataSource.transaction` callback and
     * PostgreSQL rolls the whole thing back -- profile, role and audit
     * together. An implementation that swallowed this, or wrote the audit row
     * after the commit, would leave an unaudited automatic grant: the exact
     * shape GAP-02-V3 exists to remove.
     */
    const recorded = freshRecorded();
    const audit = auditSpy(() => { throw new Error('audit insert refused'); });
    const service = serviceWith(audit);

    await expect(service.assignOwnerRole(managerFor({ recorded }), 'u1', 'professional')).rejects.toThrow(
      'audit insert refused',
    );
    expect(audit.recordSystem).toHaveBeenCalledTimes(1);
  });

  it('recomputes the denormalized column from user_roles rather than appending to it', async () => {
    const recorded = freshRecorded();
    const audit = auditSpy();
    const service = serviceWith(audit);

    await service.assignOwnerRole(managerFor({ recorded }), 'u1', 'professional');

    expect(recorded.userUpdates).toEqual([{ criteria: { id: 'u1' }, patch: { roles: ['customer', 'professional'] } }]);
  });
});

/**
 * The closed vocabulary itself, asserted rather than assumed.
 *
 * `V33-DEC-021` requires four distinguishable facts — professional and business,
 * live trigger and migration backfill — and forbids caller-supplied prose. A
 * constant renamed or a label quietly merged with `#56a`'s would pass every
 * behavioural test above while making the audit trail answer a different
 * question, so the values are pinned here.
 */
describe('the owner-role audit vocabulary', () => {
  it('admits exactly the two roles an ownership trigger may grant', () => {
    expect([...OWNER_ROLE_SLUGS]).toEqual(['professional', 'business']);
    // `administrator` is not reachable through this path by construction.
    expect(OWNER_ROLE_SLUGS as readonly string[]).not.toContain('administrator');
    expect(OWNER_ROLE_SLUGS as readonly string[]).not.toContain('platform_operator');
  });

  it('separates the live trigger from the migration backfill, and #75 from #56a', () => {
    expect(OWNER_ROLE_SYSTEM_ACTOR_LABEL).toBe('system');
    expect(OWNER_ROLE_MIGRATION_ACTOR_LABEL).toBe('migration:v3.3-#75');
    expect(OWNER_ROLE_MIGRATION_ACTOR_LABEL).not.toBe('migration:v3.3-a');
    // `actor_label` is VARCHAR(40); a longer label would fail at insert time,
    // in production, on a row nobody is watching.
    expect(OWNER_ROLE_MIGRATION_ACTOR_LABEL.length).toBeLessThanOrEqual(40);
    expect(OWNER_ROLE_SYSTEM_ACTOR_LABEL.length).toBeLessThanOrEqual(40);
  });

  it('keeps every action and target within the audit table column widths', () => {
    expect(AUDIT_TARGET_USER_ROLE.length).toBeLessThanOrEqual(40);
    for (const action of Object.values(OWNER_ROLE_AUDIT_ACTIONS)) {
      expect(action.length).toBeLessThanOrEqual(80);
    }
  });

  it('carries four distinct reasons and no free text', () => {
    const reasons = Object.values(OWNER_ROLE_AUDIT_REASONS);
    expect(new Set(reasons).size).toBe(4);
    for (const reason of reasons) expect(reason).toMatch(/^[a-z][a-z ]+$/);
  });
});

/**
 * The seller roles carry the capabilities #75 exists to make reachable.
 *
 * Not a restatement of the map: the point is that `bc_manage_own_subscription`
 * — the one capability enforced on a live route today — is on BOTH seller roles
 * and on neither `customer` nor any privileged tier. If that ever stops being
 * true, the trigger this story adds would grant a role that does not reopen the
 * surface it was added to reopen.
 */
describe('the seller roles the trigger grants', () => {
  it('gives both of them bc_manage_own_subscription and gives it to nobody else', () => {
    for (const role of OWNER_ROLE_SLUGS) {
      expect(CAPABILITIES_BY_ROLE[role]).toContain('bc_manage_own_subscription');
    }
    for (const role of ['customer', 'moderator', 'platform_operator', 'administrator'] as const) {
      expect(CAPABILITIES_BY_ROLE[role]).not.toContain('bc_manage_own_subscription');
    }
  });

  it('leaves the customer-only capabilities on customer, so the default role stays load-bearing', () => {
    for (const capability of ['bc_book_service', 'bc_use_ai_assistant', 'bc_view_own_orders']) {
      expect(CAPABILITIES_BY_ROLE.customer).toContain(capability);
      for (const role of OWNER_ROLE_SLUGS) {
        expect(CAPABILITIES_BY_ROLE[role]).not.toContain(capability);
      }
    }
  });
});
