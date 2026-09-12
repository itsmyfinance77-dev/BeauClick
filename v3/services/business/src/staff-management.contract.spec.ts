import { getMetadataArgsStorage } from 'typeorm';

import { BusinessStaffEntity } from './entities/business-staff.entity';
import { StaffDisplayIdentity, StaffIdentityLookup } from './ports';
import { STAFF_LABEL_SOURCES, StaffManagementItem, StaffManagementService } from './staff-management.service';

/**
 * The owner-only staff-management projection -- V3.3 #154, `V33-DEC-038`
 * R1-R6, R11-R12 -- proved at the unit level against fakes for the roster,
 * the grant store and the identity port. The real-PostgreSQL suite proves the
 * route, its authorization, the constant query count and the absence of any
 * write; what belongs HERE is the shape and the labelling rules, which do not
 * need a database to be wrong.
 *
 * Every id and phone below is distinct from every label, so a value showing
 * up in the wrong field is visible as a wrong string rather than a plausible
 * one.
 */

const BUSINESS = '018f4b1a-0000-7000-8000-00000000b001';

const OWNER_USER = '018f4b1a-0000-7000-8000-0000000000a1';

interface FakeMember {
  id: string;
  userId: string;
  professionalId: string | null;
  role: 'manager' | 'staff';
  status: 'invited' | 'active';
  phone: string;
  professionalName: string | null;
  identityLive?: boolean;
  professionalLive?: boolean;
}

const LINKED_A: FakeMember = {
  id: '018f4b1a-0000-7000-8000-00000000m001',
  userId: '018f4b1a-0000-7000-8000-00000000u001',
  professionalId: '018f4b1a-0000-7000-8000-00000000p001',
  role: 'staff',
  status: 'active',
  phone: '+989121110001',
  professionalName: 'سارا رضایی',
};

/** Same public name as LINKED_A, different person -- only the hint tells them apart. */
const LINKED_B: FakeMember = {
  id: '018f4b1a-0000-7000-8000-00000000m002',
  userId: '018f4b1a-0000-7000-8000-00000000u002',
  professionalId: '018f4b1a-0000-7000-8000-00000000p002',
  role: 'staff',
  status: 'active',
  phone: '+989121110002',
  professionalName: 'سارا رضایی',
};

/** The bookkeeper: consented, active, and NO professional profile. */
const BOOKKEEPER: FakeMember = {
  id: '018f4b1a-0000-7000-8000-00000000m003',
  userId: '018f4b1a-0000-7000-8000-00000000u003',
  professionalId: null,
  role: 'manager',
  status: 'active',
  phone: '+989121117777',
  professionalName: null,
};

const INVITED: FakeMember = {
  id: '018f4b1a-0000-7000-8000-00000000m004',
  userId: '018f4b1a-0000-7000-8000-00000000u004',
  professionalId: null,
  role: 'staff',
  status: 'invited',
  phone: '+989121118888',
  professionalName: null,
};

function serviceFor(members: FakeMember[], liveRoles: Record<string, string[]> = {}) {
  const staff = {
    listForBusiness: jest.fn(async () =>
      members.map(
        (member) =>
          ({
            id: member.id,
            businessId: BUSINESS,
            userId: member.userId,
            professionalId: member.professionalId,
            role: member.role,
            status: member.status,
            invitedBy: OWNER_USER,
            respondedAt: null,
            createdAt: new Date('2026-09-01T00:00:00Z'),
            updatedAt: new Date('2026-09-01T00:00:00Z'),
            locationId: null,
          }) as unknown as BusinessStaffEntity,
      ),
    ),
  };
  const grants = {
    liveRolesForMemberships: jest.fn(async (_m: unknown, _b: string, ids: readonly string[]) => {
      const map = new Map<string, string[]>();
      for (const id of ids) if (liveRoles[id]) map.set(id, liveRoles[id]);
      return map;
    }),
  };
  // The port behaves like the composition-root adapter: it masks, it answers
  // for the whole set at once, and it omits a user with no live identity row.
  const identity = {
    describeMembers: jest.fn(async (_m: unknown, lookups: readonly StaffIdentityLookup[]) => {
      const map = new Map<string, StaffDisplayIdentity>();
      for (const lookup of lookups) {
        const member = members.find((candidate) => candidate.userId === lookup.userId);
        if (!member || member.identityLive === false) continue;
        map.set(lookup.userId, {
          phoneHint: member.phone.slice(-4),
          professionalDisplayName:
            lookup.professionalId && member.professionalLive !== false ? member.professionalName : null,
        });
      }
      return map;
    }),
  };
  const dataSource = { manager: {} };
  const service = new StaffManagementService(dataSource as never, staff as never, grants as never, identity as never);
  return { service, staff, grants, identity };
}

describe('the owner-only staff-management projection (#154)', () => {
  it('carries exactly the seven ratified keys and no raw identity, professional or actor id', async () => {
    const { service } = serviceFor([LINKED_A, BOOKKEEPER, INVITED]);

    const items = await service.listForOwner(BUSINESS);
    const body = JSON.stringify(items);

    expect(items.map((item) => Object.keys(item).sort())).toEqual(
      items.map(() => ['displayLabel', 'id', 'identificationHint', 'labelSource', 'role', 'roles', 'status']),
    );
    for (const forbidden of [
      LINKED_A.userId,
      LINKED_A.professionalId!,
      BOOKKEEPER.userId,
      INVITED.userId,
      OWNER_USER,
      LINKED_A.phone,
      BOOKKEEPER.phone,
      INVITED.phone,
      'invitedBy',
      'userId',
      'professionalId',
      'email',
      'createdAt',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('labels a linked member by the professional public name, and every row by the final four digits', async () => {
    const { service } = serviceFor([LINKED_A, BOOKKEEPER]);

    const [linked, bookkeeper] = await service.listForOwner(BUSINESS);
    expect(linked).toMatchObject({
      id: LINKED_A.id,
      displayLabel: 'سارا رضایی',
      labelSource: 'professional',
      identificationHint: '0001',
    });
    expect(bookkeeper).toMatchObject({
      id: BOOKKEEPER.id,
      displayLabel: '7777',
      labelSource: 'phone',
      identificationHint: '7777',
    });
    expect(bookkeeper.displayLabel).toHaveLength(4);
  });

  it('distinguishes two members with the same public name by the hint alone', async () => {
    const { service } = serviceFor([LINKED_A, LINKED_B]);

    const [a, b] = await service.listForOwner(BUSINESS);
    expect(a.displayLabel).toBe(b.displayLabel);
    expect(a.identificationHint).not.toBe(b.identificationHint);
    expect([a.identificationHint, b.identificationHint]).toEqual(['0001', '0002']);
  });

  it('falls back to the phone label when the linked professional profile is no longer live', async () => {
    const { service } = serviceFor([{ ...LINKED_A, professionalLive: false }]);

    const [item] = await service.listForOwner(BUSINESS);
    expect(item).toMatchObject({ displayLabel: '0001', labelSource: 'phone', identificationHint: '0001' });
  });

  it('omits a membership whose identity row is not live rather than rendering it anonymous', async () => {
    const { service } = serviceFor([LINKED_A, { ...BOOKKEEPER, identityLive: false }, INVITED]);

    const items = await service.listForOwner(BUSINESS);
    expect(items.map((item) => item.id)).toEqual([LINKED_A.id, INVITED.id]);
    expect(JSON.stringify(items)).not.toContain('عضو');
  });

  it('keeps the roster order and status, and attaches each membership’s live scoped roles', async () => {
    const { service } = serviceFor([INVITED, BOOKKEEPER, LINKED_A], {
      [BOOKKEEPER.id]: ['finance_read'],
      [LINKED_A.id]: ['finance_read', 'practitioner_chat'],
    });

    const items = await service.listForOwner(BUSINESS);
    expect(items.map((item) => [item.id, item.status, item.roles])).toEqual([
      [INVITED.id, 'invited', []],
      [BOOKKEEPER.id, 'active', ['finance_read']],
      [LINKED_A.id, 'active', ['finance_read', 'practitioner_chat']],
    ]);
  });

  it('resolves identity and grants in ONE call each for the whole roster -- never per member', async () => {
    const { service, identity, grants } = serviceFor([LINKED_A, LINKED_B, BOOKKEEPER, INVITED]);

    await service.listForOwner(BUSINESS);

    expect(identity.describeMembers).toHaveBeenCalledTimes(1);
    expect((identity.describeMembers.mock.calls[0][1] as StaffIdentityLookup[]).map((l) => l.userId)).toEqual([
      LINKED_A.userId,
      LINKED_B.userId,
      BOOKKEEPER.userId,
      INVITED.userId,
    ]);
    expect(grants.liveRolesForMemberships).toHaveBeenCalledTimes(1);
    expect(grants.liveRolesForMemberships.mock.calls[0][1]).toBe(BUSINESS);
    expect(grants.liveRolesForMemberships.mock.calls[0][2]).toEqual([LINKED_A.id, LINKED_B.id, BOOKKEEPER.id, INVITED.id]);
  });

  it('an empty roster asks the ports once with an empty set and returns an empty list', async () => {
    const { service, identity } = serviceFor([]);

    expect(await service.listForOwner(BUSINESS)).toEqual([]);
    expect(identity.describeMembers).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('never invents a placeholder label: every label is a real name or exactly four digits', async () => {
    const { service } = serviceFor([LINKED_A, LINKED_B, BOOKKEEPER, INVITED]);

    for (const item of await service.listForOwner(BUSINESS)) {
      expect(item.displayLabel).not.toMatch(/نمونه|عضو|placeholder|member|^\d+$(?<!^\d{4}$)/u);
      if (item.labelSource === 'phone') expect(item.displayLabel).toMatch(/^\d{4}$/);
      else expect(item.displayLabel).toBe('سارا رضایی');
    }
  });

  it('the label-source vocabulary is exactly professional | phone', () => {
    expect([...STAFF_LABEL_SOURCES]).toEqual(['professional', 'phone']);
    const item: StaffManagementItem = {
      id: 'x',
      role: 'staff',
      status: 'active',
      displayLabel: 'x',
      labelSource: 'phone',
      identificationHint: '1234',
      roles: [],
    };
    expect(item.labelSource).toBe('phone');
  });

  it('stores nothing: no entity, column or table exists for a display label or a hint', () => {
    const columns = getMetadataArgsStorage().columns.map((column) => column.propertyName.toLowerCase());
    for (const forbidden of ['displaylabel', 'labelsource', 'identificationhint', 'phonehint']) {
      expect(columns).not.toContain(forbidden);
    }
  });
});
