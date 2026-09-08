import { readFileSync } from 'node:fs';

import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';

import { StaffService } from './staff.service';
import { InvitableIdentity, StaffInviteIdentityResolverPort } from './ports';
import { STAFF_INVITE_MIN_RESPONSE_MS, StaffInviteClock } from './staff-invite.clock';

/**
 * The invitation response-time floor -- V3.3 Story #109 (`#44c`),
 * `V33-DEC-033` R3.
 *
 * ## Why a fake clock and a fake DataSource, and no database at all
 *
 * What is under test is the FLOOR: that every semantic outcome waits out the
 * same minimum, and that no path escapes it. A real database would make that a
 * statistical question with a real sleep in it; here it is a deterministic one.
 * The distribution question -- do the paths actually come out comparable against
 * a real server -- is a different claim and is measured separately in
 * `apps/api/test/scoped-staff-authority.pg-spec.ts`.
 *
 * `V33-DEC-033` R3 is explicit that this is a **mitigation**, never
 * constant-time behaviour, and these cases claim no more than they prove.
 */

/** A clock the test drives by hand. `sleep` records rather than waits. */
class FakeClock implements StaffInviteClock {
  now = 0;
  readonly slept: number[] = [];

  monotonicNowMs(): number {
    return this.now;
  }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    if (ms > 0) this.now += ms;
  }
}

/**
 * A DataSource whose `transaction` runs `work` against a manager that answers
 * every query with a caller-supplied script.
 *
 * Deliberately tiny: the invitation's *behaviour* is proved against real
 * PostgreSQL. What this stands in for is only "some database work happened, and
 * took `costMs`".
 */
function fakeDataSource(options: {
  clock: FakeClock;
  costMs: number;
  rows: (sql: string) => unknown;
  throws?: Error;
}): DataSource {
  return {
    transaction: async (work: (manager: unknown) => Promise<unknown>) => {
      const charge = () => {
        options.clock.now += options.costMs;
        if (options.throws) throw options.throws;
      };
      const manager = {
        query: async (sql: string) => {
          charge();
          return options.rows(sql);
        },
        // The outbox writer goes through a repository rather than raw SQL, so
        // the fake charges for it too -- otherwise the known-eligible path would
        // look cheaper here than it is in production.
        getRepository: () => ({
          create: (row: unknown) => row,
          save: async (row: unknown) => {
            charge();
            return row;
          },
          insert: async () => {
            charge();
            return { identifiers: [] };
          },
        }),
      };
      return work(manager);
    },
  } as unknown as DataSource;
}

const audit = { record: async () => undefined } as unknown as AdminAuditService;
const repository = {} as never;

function serviceWith(clock: FakeClock, dataSource: DataSource, identity: InvitableIdentity | null): StaffService {
  const identities: StaffInviteIdentityResolverPort = { resolveInvitableIdentity: async () => identity };
  return new StaffService(
    repository as unknown as never,
    repository as unknown as never,
    dataSource,
    audit,
    identities,
    clock,
  );
}

describe('the invitation response-time floor (#109)', () => {
  const businessId = uuidv7();
  const ownerId = uuidv7();
  const liveBusinessRow = [{ id: businessId }];

  it('waits out the floor on the UNKNOWN-phone path, which writes nothing', async () => {
    const clock = new FakeClock();
    const service = serviceWith(clock, fakeDataSource({ clock, costMs: 4, rows: () => liveBusinessRow }), null);

    await service.inviteByPhone(businessId, ownerId, { phone: '09120000000', role: 'staff' });

    // One owner probe at 4 ms, then the remainder of the floor.
    expect(clock.slept).toEqual([STAFF_INVITE_MIN_RESPONSE_MS - 4]);
    expect(clock.now).toBe(STAFF_INVITE_MIN_RESPONSE_MS);
  });

  it('waits out the SAME total on the self-invite path', async () => {
    const clock = new FakeClock();
    const service = serviceWith(clock, fakeDataSource({ clock, costMs: 4, rows: () => liveBusinessRow }), {
      userId: ownerId,
      professionalId: null,
    });

    await service.inviteByPhone(businessId, ownerId, { phone: '09120000000', role: 'staff' });

    expect(clock.now).toBe(STAFF_INVITE_MIN_RESPONSE_MS);
  });

  it('waits out the SAME total on the known-eligible path, which does more work', async () => {
    const clock = new FakeClock();
    // Three statements at 8 ms each: the owner probe, the membership insert and
    // the outbox write. The floor absorbs all of it.
    const service = serviceWith(
      clock,
      fakeDataSource({
        clock,
        costMs: 8,
        // The REAL driver shape for `INSERT … RETURNING id`: a bare rows
        // array, with no count element. A fake that invented `[rows, count]`
        // here is what let the production defect hide — it made the broken
        // count look correct in the fast layer.
        rows: (sql) => {
          if (sql.includes('INSERT INTO business.business_staff')) return [{ id: 'inserted' }];
          // The "affiliated elsewhere" probe: nobody else has this person.
          if (sql.includes('business_id <> $2')) return [];
          return liveBusinessRow;
        },
      }),
      { userId: uuidv7(), professionalId: uuidv7() },
    );

    await service.inviteByPhone(businessId, ownerId, { phone: '09120000000', role: 'staff' });

    expect(clock.now).toBe(STAFF_INVITE_MIN_RESPONSE_MS);
  });

  it('waits out the SAME total on the duplicate path, where the insert affects no row', async () => {
    const clock = new FakeClock();
    const service = serviceWith(
      clock,
      fakeDataSource({
        clock,
        costMs: 8,
        rows: (sql) => {
          // `ON CONFLICT DO NOTHING` that conflicted: zero returned rows.
          if (sql.includes('INSERT INTO business.business_staff')) return [];
          if (sql.includes('business_id <> $2')) return [];
          return liveBusinessRow;
        },
      }),
      { userId: uuidv7(), professionalId: null },
    );

    await service.inviteByPhone(businessId, ownerId, { phone: '09120000000', role: 'staff' });

    expect(clock.now).toBe(STAFF_INVITE_MIN_RESPONSE_MS);
  });

  it('CANNOT be bypassed by an exception -- the floor is in a `finally`', async () => {
    /*
     * The probe this case exists to kill: moving the floor out of `finally` and
     * onto the success path only. A thrown request would then return
     * immediately, and "how long did it take" would once again distinguish
     * outcomes -- the exact oracle the floor removes.
     */
    const clock = new FakeClock();
    const boom = new Error('database refused (deliberate)');
    const service = serviceWith(clock, fakeDataSource({ clock, costMs: 3, rows: () => [], throws: boom }), null);

    await expect(service.inviteByPhone(businessId, ownerId, { phone: '09120000000', role: 'staff' })).rejects.toThrow(
      'database refused (deliberate)',
    );

    expect(clock.slept).toEqual([STAFF_INVITE_MIN_RESPONSE_MS - 3]);
    expect(clock.now).toBe(STAFF_INVITE_MIN_RESPONSE_MS);
  });

  it('never sleeps a NEGATIVE amount when the work already exceeded the floor', async () => {
    // Honest about its own limits: a pathologically slow database pushes the
    // response past the floor, and the floor does not -- and cannot -- claw that
    // back. `sleep` treats a non-positive argument as a no-op rather than
    // waiting or throwing.
    const clock = new FakeClock();
    const slow = STAFF_INVITE_MIN_RESPONSE_MS + 40;
    const service = serviceWith(clock, fakeDataSource({ clock, costMs: slow, rows: () => liveBusinessRow }), null);

    await service.inviteByPhone(businessId, ownerId, { phone: '09120000000', role: 'staff' });

    expect(clock.slept).toEqual([-40]);
    // `sleep` ignored it, so no time was added beyond the real work.
    expect(clock.now).toBe(slow);
  });

  it('uses a MONOTONIC reading, never a wall clock', () => {
    // A wall clock can step backwards under NTP, which would silently skip the
    // floor exactly once and leave no trace. The seam exists so the production
    // implementation can be `process.hrtime.bigint()` and the test can be exact.
    const source = readFileSync(`${__dirname}/staff-invite.clock.ts`, 'utf8');
    // Comments are stripped first: the docblock legitimately NAMES `Date.now()`
    // as the thing this must not be, which is exactly the sentence a reviewer
    // needs and exactly the string a naive whole-file scan would flag.
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0)
      .join('\n');

    expect(executable).toContain('process.hrtime.bigint()');
    expect(executable).not.toContain('Date.now()');
    expect(executable).not.toContain('new Date(');
    // The discovery half: the stripped source is real code, not an empty string
    // that would make the two refusals above vacuously true.
    expect(executable).toContain('export class SystemStaffInviteClock');
  });
});
