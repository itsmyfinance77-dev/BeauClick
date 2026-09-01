import { INestApplication, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
  tombstoneFor,
} from '@beauclick/subject-data';
import { ALL_EVENT_CONTRACTS } from '@beauclick/event-contracts';
import {
  REFERRAL_CODE_LENGTH,
  REFERRAL_SHARE_CHANNELS,
  isReferralCodeShape,
} from '@beauclick/referral-contract';
import {
  REFERRAL_CODE_GENERATOR,
  ReferralCodeGenerator,
  ReferralService,
  ReferralSubjectDataContract,
} from '@beauclick/referral';

import { PgTestApp, SeededUser, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

/**
 * The instant every erasure in this file is stamped with.
 *
 * `SubjectDataContract.eraseSubjectData` has always taken a `SubjectTombstone`
 * third argument — `PrivacyService` has always passed one — and this module
 * simply had no use for it while `referral_codes` was the only table it owned,
 * so the implementation omitted the parameter and these calls omitted the
 * argument.
 *
 * V3.2-C Story #27 gave the module a **retained** table whose erased side must
 * be tombstoned (`V32-DEC-019`), so the parameter is now declared and used, and
 * these call sites pass what the real caller passes: the platform's shared
 * `tombstoneFor`, not a local placeholder.
 *
 * A fixed instant rather than `new Date()`, so an assertion about *when* a
 * subject was erased can never depend on how long the test took.
 */
const ERASED_AT = new Date('2026-07-01T00:00:00.000Z');

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * The referral foundation, proved against real PostgreSQL (V3.2-C Story #11,
 * ADR-035).
 *
 * Everything that matters about this module is a database guarantee — the two
 * unique constraints, the generate-and-retry that rests on one of them, the
 * concurrent-first-read race that rests on the other, and the erasure that makes
 * an ownerless code unrepresentable. pg-mem honours none of them (it does not
 * even honour ROLLBACK), so they are proved here or nowhere.
 */
describePg('referral — code identity, generation, privacy, and the share boundary (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let referral: ReferralService;
  /**
   * The module's own code-generation seam, resolved from the running
   * application (`REFERRAL_CODE_GENERATOR`).
   *
   * Spied rather than replaced, and reached through DI rather than by importing
   * the generator's file: a test that patched another project's module exports
   * by relative path is exactly what `@nx/enforce-module-boundaries` refuses,
   * and it would break the moment the package was restructured.
   */
  let generator: ReferralCodeGenerator;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    referral = app.get(ReferralService);
    generator = app.get<ReferralCodeGenerator>(REFERRAL_CODE_GENERATOR);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const http = () => request(app.getHttpServer());

  const readCode = (user: SeededUser, query = '') =>
    http().get(`/api/v1/me/referral/code${query}`).set('Authorization', `Bearer ${user.accessToken}`);

  let seq = 0;
  async function customer(): Promise<SeededUser> {
    seq += 1;
    return seedUser(app, dataSource, `+9891290${String(seq).padStart(5, '0')}`);
  }

  async function storedCodes(userId?: string): Promise<Array<{ code: string; owner_user_id: string }>> {
    return userId
      ? dataSource.query('SELECT code, owner_user_id FROM referral.referral_codes WHERE owner_user_id = $1', [userId])
      : dataSource.query('SELECT code, owner_user_id FROM referral.referral_codes');
  }

  /**
   * Records every SQL statement the application issues while `run` executes.
   *
   * TypeORM creates a query runner per operation, so wrapping `createQueryRunner`
   * catches repository calls, query-builder calls, and raw `manager.query` alike
   * — which is what makes this a real record rather than a record of the one
   * path somebody remembered to instrument.
   */
  async function recordSql<T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const sql: string[] = [];
    const original = dataSource.createQueryRunner.bind(dataSource);
    const spy = jest.spyOn(dataSource, 'createQueryRunner').mockImplementation(((mode?: 'master' | 'slave') => {
      const runner: QueryRunner = original(mode);
      const query = runner.query.bind(runner);
      runner.query = ((statement: string, parameters?: unknown[], useStructuredResult?: boolean) => {
        sql.push(statement);
        return query(statement, parameters as never, useStructuredResult as never);
      }) as QueryRunner['query'];
      return runner;
    }) as typeof dataSource.createQueryRunner);
    try {
      return { result: await run(), sql };
    } finally {
      spy.mockRestore();
    }
  }

  /**
   * Everything logged while `run` executed, captured two ways.
   *
   * `args` is what any code handed to a `Logger` method, and it is the
   * load-bearing half: it is the exact material a log line is built from, so a
   * code that never appears here cannot appear in a log line however the sink is
   * configured. `output` is what actually reached the process streams, which
   * additionally covers anything logging outside Nest's `Logger`.
   *
   * Both are needed. An earlier version of this helper captured only the streams
   * and the assertion passed while capturing NOTHING — the non-vacuity guard is
   * what caught it, and the argument capture is what replaced the guesswork.
   */
  async function recordLogging<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; args: string; output: string }> {
    const args: unknown[] = [];
    let output = '';

    const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
    const loggerSpies = methods.map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(((...called: unknown[]) => {
        args.push(...called);
      }) as never),
    );

    const capture = (chunk: unknown): boolean => {
      output += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);

    try {
      const result = await run();
      return { result, args: JSON.stringify(args), output };
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const spy of loggerSpies) spy.mockRestore();
    }
  }

  // -------------------------------------------------------------------------
  // 1. The code itself
  // -------------------------------------------------------------------------

  describe('code generation', () => {
    it('creates the caller\'s code on first read and returns the same one thereafter', async () => {
      const user = await customer();

      const first = await readCode(user).expect(200);
      const second = await readCode(user).expect(200);
      const third = await readCode(user).expect(200);

      // Idempotent in the strong sense: not merely the same code, the same
      // BODY. Nothing observable changes between the first call and the third,
      // which is what makes a mutating GET defensible (ADR-035 §5).
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);

      expect(await storedCodes(user.id)).toHaveLength(1);
    });

    it('uses the approved alphabet and the exact format', async () => {
      const user = await customer();
      const code = (await readCode(user).expect(200)).body.data.code as string;

      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(isReferralCodeShape(code)).toBe(true);
      // Asserted against a LITERAL as well as the predicate, so a change to the
      // contract alone cannot make this pass silently.
      expect(code).toMatch(/^[123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
      for (const ambiguous of ['I', 'L', 'O', 'U', '0']) expect(code).not.toContain(ambiguous);
    });

    it('gives different owners different codes', async () => {
      const users = [await customer(), await customer(), await customer(), await customer()];
      const codes = await Promise.all(users.map(async (u) => (await readCode(u).expect(200)).body.data.code));

      expect(new Set(codes).size).toBe(users.length);
    });

    it('reveals nothing about the owner', async () => {
      const user = await customer();
      const code = (await readCode(user).expect(200)).body.data.code as string;

      // Not the user id, not any fragment of it, not the phone, not any fragment
      // of that. The generator takes no arguments at all (ADR-035 §3), so this
      // asserts a property the signature already makes structural.
      expect(code).not.toContain(user.id);
      expect(code).not.toContain(user.phone);
      const upper = code.toUpperCase();
      for (const fragment of user.id.replace(/-/g, '').match(/.{4}/g) ?? []) {
        expect(upper).not.toContain(fragment.toUpperCase());
      }
      for (const fragment of user.phone.replace(/\D/g, '').match(/.{4}/g) ?? []) {
        expect(upper).not.toContain(fragment);
      }
    });

    it('is stable across a backdated row, because the code has NO independent expiry', async () => {
      // `V32-DEC-033`: the invite link has no independent expiry and its validity
      // follows the code and the referral lifecycle. Proved two ways.
      const user = await customer();
      const original = (await readCode(user).expect(200)).body.data;

      // Ten years old. Nothing anywhere may treat that as expired.
      await dataSource.query(
        "UPDATE referral.referral_codes SET created_at = now() - interval '10 years' WHERE owner_user_id = $1",
        [user.id],
      );

      const later = await readCode(user).expect(200);
      expect(later.body.data).toEqual(original);
      expect(await storedCodes(user.id)).toHaveLength(1);
    });

    it('has no expiry, revocation, or counter column at all', async () => {
      // Structural, and the stronger half of the previous case: a code cannot
      // expire because there is nowhere to record that it did. Asserted against
      // a literal so a later migration adding one has to come here and say why.
      const rows = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'referral' AND table_name = 'referral_codes'
          ORDER BY column_name`,
      );
      expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
        'code',
        'created_at',
        'id',
        'owner_user_id',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Uniqueness, collisions, and concurrency
  // -------------------------------------------------------------------------

  describe('uniqueness and concurrency', () => {
    it('makes a duplicate code UNWRITABLE at the database, independently of the service', async () => {
      // The service's retry is a convenience. The guarantee is the index, and
      // this proves it by going around the service entirely.
      const user = await customer();
      const code = (await readCode(user).expect(200)).body.data.code as string;

      await expect(
        dataSource.query(
          'INSERT INTO referral.referral_codes (id, owner_user_id, code) VALUES ($1, $2, $3)',
          [uuidv7(), (await customer()).id, code],
        ),
      ).rejects.toThrow(/uq_referral_codes_code|duplicate key/i);
    });

    it('makes a second code for one owner UNWRITABLE at the database', async () => {
      const user = await customer();
      await readCode(user).expect(200);

      await expect(
        dataSource.query(
          'INSERT INTO referral.referral_codes (id, owner_user_id, code) VALUES ($1, $2, $3)',
          [uuidv7(), user.id, 'ZZZZZZZZZZ'],
        ),
      ).rejects.toThrow(/uq_referral_codes_owner|duplicate key/i);
    });

    it('refuses a code that violates the alphabet, even inserted directly', async () => {
      // `ck_referral_codes_shape`. This is the constraint that still holds when
      // somebody bypasses the service -- which is exactly what the forced
      // collision below does, and what a future backfill migration would do.
      const user = await customer();
      for (const bad of ['SHORT', 'lowercase1', 'CONTAINS0X1', 'HASOINIT12', 'TOOLONGCODE12']) {
        await expect(
          dataSource.query('INSERT INTO referral.referral_codes (id, owner_user_id, code) VALUES ($1, $2, $3)', [
            uuidv7(),
            user.id,
            bad,
          ]),
        ).rejects.toThrow(/ck_referral_codes_shape|violates check constraint/i);
      }
    });

    it('RETRIES with a fresh code when a generated one is already taken', async () => {
      // The forced collision. Without it the retry loop is a path nobody knows
      // works, because at ~49.5 bits a natural collision will never be observed.
      const incumbent = await customer();
      const taken = (await readCode(incumbent).expect(200)).body.data.code as string;

      const newcomer = await customer();
      const spy = jest
        .spyOn(generator, 'next')
        // First draw collides with the incumbent; the second is a real one.
        .mockImplementationOnce(() => taken);

      const res = await readCode(newcomer).expect(200);

      // It really did collide -- otherwise this case proves nothing.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(res.body.data.code).not.toBe(taken);
      expect(isReferralCodeShape(res.body.data.code)).toBe(true);

      // And both owners still hold exactly one code each.
      expect(await storedCodes(incumbent.id)).toHaveLength(1);
      expect(await storedCodes(newcomer.id)).toHaveLength(1);
    });

    it('survives several consecutive collisions before succeeding', async () => {
      const incumbent = await customer();
      const taken = (await readCode(incumbent).expect(200)).body.data.code as string;

      const newcomer = await customer();
      const spy = jest
        .spyOn(generator, 'next')
        .mockImplementationOnce(() => taken)
        .mockImplementationOnce(() => taken)
        .mockImplementationOnce(() => taken);

      const res = await readCode(newcomer).expect(200);
      expect(spy).toHaveBeenCalledTimes(4);
      expect(res.body.data.code).not.toBe(taken);
    });

    it('two concurrent FIRST reads create exactly one row and return the SAME code', async () => {
      // The race the read-first path cannot close: both requests find no row and
      // both insert. `uq_referral_codes_owner` decides the winner, and the loser
      // must re-read rather than draw again -- drawing again would try to mint a
      // second code for an owner who now has one.
      const user = await customer();

      const results = await Promise.all([readCode(user), readCode(user), readCode(user), readCode(user)]);

      for (const res of results) expect(res.status).toBe(200);
      const codes = results.map((r) => r.body.data.code);
      expect(new Set(codes).size).toBe(1);

      expect(await storedCodes(user.id)).toHaveLength(1);
      expect(codes[0]).toBe((await storedCodes(user.id))[0].code);
    });

    it('keeps concurrent first reads for DIFFERENT owners independent', async () => {
      const users = await Promise.all([customer(), customer(), customer(), customer(), customer()]);

      const results = await Promise.all(users.map((u) => readCode(u)));
      for (const res of results) expect(res.status).toBe(200);

      const codes = results.map((r) => r.body.data.code);
      expect(new Set(codes).size).toBe(users.length);
      expect(await storedCodes()).toHaveLength(users.length);
    });

    it('NEVER performs a read-before-write availability check', async () => {
      // ADR-035 §4. A `SELECT ... WHERE code = $1` before the insert is
      // `GAP-04` in miniature: two concurrent generations both observe the code
      // free under READ COMMITTED and both proceed.
      const user = await customer();

      const { sql } = await recordSql(() => readCode(user).expect(200));

      const referralStatements = sql.filter((s) => /referral_codes/i.test(s));
      expect(referralStatements.length).toBeGreaterThan(0);

      const selects = referralStatements.filter((s) => /^\s*SELECT/i.test(s));
      // Every SELECT this route issues is scoped by OWNER, never by code. A
      // lookup by code before the insert is exactly the forbidden shape.
      for (const statement of selects) {
        expect(statement).toMatch(/owner_user_id/i);
        expect(statement).not.toMatch(/WHERE[\s\S]*"?code"?\s*=/i);
      }

      // And the write really is an INSERT rather than an upsert that hides a
      // read: `ON CONFLICT DO UPDATE` would silently make the owner race
      // last-write-wins instead of first-write-wins.
      const inserts = referralStatements.filter((s) => /^\s*INSERT/i.test(s));
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).not.toMatch(/ON CONFLICT/i);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The route, the link, and the share payload
  // -------------------------------------------------------------------------

  describe('the read route and the share contract', () => {
    it('returns exactly the browser-contract key set', async () => {
      const user = await customer();
      const data = (await readCode(user).expect(200)).body.data;

      // Against an independently written literal. A new key fails this until
      // somebody edits it, which is the reviewable act the assertion exists for.
      expect(Object.keys(data).sort()).toEqual(['code', 'inviteUrl', 'shareChannels', 'shareText']);
      // No internal identifier and no subject id crosses the contract.
      expect(data).not.toHaveProperty('id');
      expect(data).not.toHaveProperty('ownerUserId');
      expect(data).not.toHaveProperty('createdAt');
      expect(JSON.stringify(data)).not.toContain(user.id);
    });

    it('builds inviteUrl from the CONFIGURED origin and the exact route shape', async () => {
      const user = await customer();
      const data = (await readCode(user).expect(200)).body.data;

      // The harness configures PUBLIC_WEB_BASE_URL as http://localhost:3100.
      expect(data.inviteUrl).toBe(`http://localhost:3100/invite/${data.code}`);
      const url = new URL(data.inviteUrl);
      expect(url.origin).toBe('http://localhost:3100');
      expect(url.pathname).toBe(`/invite/${data.code}`);
      // Carries the code and nothing else -- no id, phone, name, or signature.
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
    });

    it('offers the approved share channels and a fixed-template share text', async () => {
      const user = await customer();
      const data = (await readCode(user).expect(200)).body.data;

      expect(data.shareChannels).toEqual([...REFERRAL_SHARE_CHANNELS]);
      expect(data.shareText).toContain(data.code);
      // Persian, and carrying no personal data of any kind.
      expect(data.shareText).toMatch(/[؀-ۿ]/);
      expect(data.shareText).not.toContain(user.phone);
      expect(data.shareText).not.toContain(user.id);
    });

    it('rejects an unauthenticated caller', async () => {
      await http().get('/api/v1/me/referral/code').expect(401);
      expect(await storedCodes()).toHaveLength(0);
    });

    it('scopes the code to the session and nothing else', async () => {
      const a = await customer();
      const b = await customer();

      const aCode = (await readCode(a).expect(200)).body.data.code;
      const bCode = (await readCode(b).expect(200)).body.data.code;

      expect(aCode).not.toBe(bCode);
      // The only thing that changes the answer is the bearer token.
      expect((await readCode(a).expect(200)).body.data.code).toBe(aCode);
      expect((await readCode(b).expect(200)).body.data.code).toBe(bCode);
    });

    it('REJECTS a forged owner identity rather than ignoring it', async () => {
      const a = await customer();
      const b = await customer();
      await readCode(b).expect(200);
      const bCode = (await storedCodes(b.id))[0].code;

      // `forbidNonWhitelisted` refuses the attempt outright, which is stronger
      // than ignoring it: a silently-ignored field is one somebody later wires
      // up by accident.
      for (const forged of ['ownerId', 'userId', 'ownerUserId', 'customerId', 'subjectUserId']) {
        await readCode(a, `?${forged}=${b.id}`).expect(400);
      }

      // A header cannot reach the subject either -- the only identity is the JWT.
      const viaHeader = await http()
        .get('/api/v1/me/referral/code')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('X-Owner-User-Id', b.id)
        .set('X-User-Id', b.id)
        .expect(200);
      expect(viaHeader.body.data.code).not.toBe(bCode);
      expect(viaHeader.body.data.code).toBe((await storedCodes(a.id))[0].code);
    });

    it('exposes no route that can address another party\'s code', async () => {
      // The refusal boundary is preserved by there being no question to ask
      // (ADR-035 §10). Story #27 owns the route that looks a code up by value,
      // and `V32-DEC-019` already binds it to one indistinguishable response.
      const a = await customer();
      const b = await customer();
      const bCode = (await readCode(b).expect(200)).body.data.code;

      // Every plausible way somebody might try to reach it. All 404, and none
      // returns the code.
      for (const path of [
        `/api/v1/referral/${bCode}`,
        `/api/v1/referral/codes/${bCode}`,
        `/api/v1/me/referral/code/${bCode}`,
        `/api/v1/me/referral/codes/${b.id}`,
        `/api/v1/referral/${b.id}/code`,
      ]) {
        const res = await http().get(path).set('Authorization', `Bearer ${a.accessToken}`);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(bCode);
      }
    });

    it('answers identically for a missing route whether or not the code exists', async () => {
      // Missing and inaccessible are the same response, because neither route
      // exists. Compared body-to-body rather than status-to-status.
      const a = await customer();
      const b = await customer();
      const realCode = (await readCode(b).expect(200)).body.data.code;

      const real = await http().get(`/api/v1/referral/${realCode}`).set('Authorization', `Bearer ${a.accessToken}`);
      const invented = await http().get('/api/v1/referral/ZZZZZZZZZZ').set('Authorization', `Bearer ${a.accessToken}`);

      expect(real.status).toBe(invented.status);
      expect(real.body).toEqual(invented.body);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The code never leaves the authenticated read route
  // -------------------------------------------------------------------------

  describe('the code is a bearer credential and stays on its one route', () => {
    it('appears in NO log line, event, notification, or analytics row', async () => {
      // `V32-DEC-033`: a referral code never enters an event payload,
      // notification payload, analytics dimension, metric label, or log line.
      const user = await customer();

      const { result, args, output } = await recordLogging(() => readCode(user).expect(200));
      const code = (result as request.Response).body.data.code as string;

      // Everything handed to a logger while the code was being MINTED -- the one
      // request where a careless log line is most tempting, because it is the
      // only one where the code is a fresh interesting value.
      expect(args).not.toContain(code);
      expect(output).not.toContain(code);

      // Non-vacuity: something WAS logged, so the capture is real. This module
      // deliberately logs the creation (with the subject id and no code), and an
      // assertion that passed against an empty capture would prove nothing --
      // which is exactly what happened before this guard was added.
      expect(args).toContain('referral code created for subject');
      expect(args).toContain(user.id);

      // Every outbox in the database. `referral` has none at all, which is the
      // structural half; the others must not have grown a row either.
      const outboxes = await dataSource.query(
        `SELECT schemaname || '.' || tablename AS t FROM pg_tables
          WHERE tablename = 'outbox_events' AND schemaname <> 'financial'`,
      );
      for (const { t } of outboxes as Array<{ t: string }>) {
        const [{ hit }] = await dataSource.query(
          `SELECT count(*)::int AS hit FROM ${t} WHERE payload::text LIKE $1`,
          [`%${code}%`],
        );
        expect({ table: t, hit }).toEqual({ table: t, hit: 0 });
      }

      const [{ notifications }] = await dataSource.query(
        'SELECT count(*)::int AS notifications FROM notification.notifications',
      );
      expect(notifications).toBe(0);
      const [{ events }] = await dataSource.query('SELECT count(*)::int AS events FROM analytics.events');
      expect(events).toBe(0);
    });

    it('has no outbox table in the referral schema at all', async () => {
      // The structural half of the previous case. `V32-DEC-033` approves
      // ReferralQualified and ReferralReversed for the REWARD path; neither
      // Story #11 nor Story #27 produces either, so a table nothing writes would
      // still need a subject-data claim nobody could verify.
      //
      // This pinned the schema at exactly `['referral_codes']` until V3.2-C
      // Story #27 added `referrals` and `claim_attempts`. Widening the list
      // would keep the case passing while it silently stopped checking anything
      // -- the next table added would just be appended again.
      //
      // So the assertion now says what it always meant: NO OUTBOX, and nothing
      // from the reward path. A new table is allowed; an outbox table, a
      // reward_grants, or a referrer_counters is not, and each would fail here
      // before its migration was reviewed.
      const rows = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'referral' ORDER BY tablename`,
      );
      const tables = rows.map((r: { tablename: string }) => r.tablename);

      // Widened once by Story #27 and again by Story #12, which is the pattern
      // that shows the LIST was never the guarantee -- appending to it each
      // story keeps the case green while it checks less and less.
      //
      // What it protects is stated directly now: nothing from Story #28. The
      // three tables it used to forbid all exist legitimately, each having
      // arrived WITH the behaviour that fills it -- which is precisely the
      // condition ADR-035 §7 set for creating an outbox at all.
      expect(tables).toEqual([
        'claim_attempts',
        'outbox_events',
        'referral_codes',
        'referrals',
        'referrer_counters',
        'reward_grants',
      ]);

      for (const notYetBuilt of ['reversals', 'clawbacks', 'refund_events', 'reward_reversals']) {
        expect(tables).not.toContain(notYetBuilt);
      }
    });

    it('emits no event contract naming referral', async () => {
      // `referral` IS in `ServiceName` (ADR-035 §1) so Story #12 can declare its
      // approved events without editing a closed vocabulary. This story declares
      // none, and that distinction is what this asserts.
      // This asserted NO contract named or produced by `referral`, which was
      // right while Story #11 declared none. V3.2-C Story #12 declares exactly
      // one, so the assertion becomes the sharper statement: the referral
      // domain produces `ReferralQualified` and NOTHING else.
      //
      // `V32-DEC-033` approves `ReferralQualified` v1 and `ReferralReversed` v1
      // and nothing else; the second is Story #28's, and `ReferralAttributed`
      // is refused outright because it has no consumer.
      const produced = (ALL_EVENT_CONTRACTS as Array<{ name: string; producer: string }>)
        .filter((contract) => contract.producer === 'referral')
        .map((contract) => contract.name);
      expect(produced).toEqual(['ReferralQualified']);

      for (const contract of ALL_EVENT_CONTRACTS as Array<{ name: string; producer: string }>) {
        // NOT `/invite/` -- `StaffInvited` is a pre-existing business-domain
        // event about inviting somebody to a BUSINESS, and it has nothing to do
        // with referral invites. A regex broad enough to catch it is a regex
        // that will be loosened by the next person who trips over it, which is
        // worse than one that says what it means.
        expect(contract.name).not.toMatch(
          /ReferralAttributed|ReferralReversed|ReferralRewarded|ReferralCapped|ReferralExpired/,
        );
      }
    });

    it('has no foreign key out of the referral schema', async () => {
      // An `ON DELETE CASCADE` to `identity.users` would make erasure LOOK like
      // it worked while the module's own subject-data contract -- the thing
      // ADR-027 makes verifiable -- did nothing.
      const rows = await dataSource.query(
        `SELECT conname FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'referral' AND c.contype = 'f'`,
      );
      expect(rows).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Privacy
  // -------------------------------------------------------------------------

  describe('subject data', () => {
    it('claims the code table as subject_data, and claims no table that does not exist', async () => {
      const contract = app.get(ReferralSubjectDataContract);
      expect(contract.moduleKey).toBe('referral');

      // This pinned the whole list at one entry until V3.2-C Story #27 added
      // `referral.referrals` (retained) and `referral.claim_attempts`
      // (subject_data). The count was never the guarantee -- these two were:
      //
      //   the CODE table's disposition, which `V32-DEC-019` ratifies as
      //   subject_data because an ownerless code must not remain claimable; and
      //
      //   that nothing from the reward path is claimed early, because
      //   `claimed_but_absent` fails the boot and a stale claim reads as
      //   coverage while covering nothing.
      expect(contract.tables).toContainEqual({
        table: 'referral.referral_codes',
        disposition: 'subject_data',
      });

      // `reward_grants` and `referrer_counters` were listed here as not-yet-
      // built until V3.2-C Story #12 built and claimed both. The guarantee
      // survives with a different list: nothing may be claimed ahead of the
      // behaviour that fills it, because `claimed_but_absent` fails the boot
      // and a stale claim reads as coverage while covering nothing.
      const claimed = contract.tables.map((claim) => claim.table);
      for (const notYetBuilt of ['referral.reversals', 'referral.clawbacks', 'referral.refund_events']) {
        expect(claimed).not.toContain(notYetBuilt);
      }

      // And every claim names a table that actually exists -- the same rule,
      // checked against reality rather than against a hand-written list.
      const real: Array<{ tablename: string }> = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'referral'`,
      );
      const realNames = real.map((row) => `referral.${row.tablename}`);
      for (const claim of claimed) {
        expect(realNames).toContain(claim);
      }
    });

    it('exports the subject\'s own code, and only the code and an instant', async () => {
      const user = await customer();
      const other = await customer();
      const code = (await readCode(user).expect(200)).body.data.code as string;
      const otherCode = (await readCode(other).expect(200)).body.data.code as string;

      const contract = app.get(ReferralSubjectDataContract);
      const sections = await contract.exportSubjectData(dataSource.manager, user.id);

      // The CODE section, addressed by key rather than by index. It was
      // `sections[0]` and asserted `sections` had length one, until V3.2-C
      // Story #27 added the two attribution sections. Addressing by key is what
      // this should always have done: a positional assertion breaks when a
      // section is added ahead of it, which says nothing about whether the
      // guarantee still holds.
      const codes = sections.find((section) => section.key === 'referral_codes');
      expect(codes).toBeDefined();
      expect(codes!.rows).toHaveLength(1);
      expect(Object.keys(codes!.rows[0]).sort()).toEqual(['code', 'createdAt']);
      expect(codes!.rows[0].code).toBe(code);

      // `V32-DEC-019` binds the shape: a referrer's export carries their OWN
      // code and no other party's anything. Asserted over the WHOLE document,
      // so a section added by a later story is covered by it too -- which is
      // exactly what happened, and this is the half that had to keep working.
      expect(JSON.stringify(sections)).not.toContain(otherCode);
      expect(JSON.stringify(sections)).not.toContain(other.id);
    });

    it('exports an empty section for a subject who never read their code', async () => {
      const user = await customer();
      const contract = app.get(ReferralSubjectDataContract);
      const sections = await contract.exportSubjectData(dataSource.manager, user.id);
      // A section with zero rows rather than no section: the document says "we
      // hold none of this", which is a different claim from silence.
      expect(sections[0].rows).toEqual([]);
    });

    it('erasure DELETES the code and leaves it unclaimable', async () => {
      const user = await customer();
      const survivor = await customer();
      const code = (await readCode(user).expect(200)).body.data.code as string;
      await readCode(survivor).expect(200);

      const contract = app.get(ReferralSubjectDataContract);
      const outcome = await contract.eraseSubjectData(dataSource.manager, user.id, tombstoneFor(user.id, ERASED_AT));

      // Deleted, not anonymised. `V32-DEC-019`: an ownerless code must not
      // remain claimable, and an anonymised row IS an ownerless code.
      expect(outcome).toEqual({ moduleKey: 'referral', anonymized: 0, deleted: 1, retained: [] });

      // Gone entirely -- not tombstoned, not reassigned, not present under any
      // owner. Nothing could look it up afterwards.
      const [{ hit }] = await dataSource.query(
        'SELECT count(*)::int AS hit FROM referral.referral_codes WHERE code = $1',
        [code],
      );
      expect(hit).toBe(0);
      expect(await storedCodes(user.id)).toHaveLength(0);
      // And the other customer is untouched.
      expect(await storedCodes(survivor.id)).toHaveLength(1);
    });

    it('frees the string, so an erased owner\'s code cannot linger as a reservation', async () => {
      const user = await customer();
      const code = (await readCode(user).expect(200)).body.data.code as string;

      const contract = app.get(ReferralSubjectDataContract);
      await contract.eraseSubjectData(dataSource.manager, user.id, tombstoneFor(user.id, ERASED_AT));

      // The unique index no longer holds it, which is the observable form of
      // "hard delete rather than revoke": a soft-revoked row would still occupy
      // the string and this insert would fail.
      const newcomer = await customer();
      await dataSource.query('INSERT INTO referral.referral_codes (id, owner_user_id, code) VALUES ($1, $2, $3)', [
        uuidv7(),
        newcomer.id,
        code,
      ]);
      expect((await storedCodes(newcomer.id))[0].code).toBe(code);
    });

    it('lets an erased subject read a FRESH code rather than resurrecting the old one', async () => {
      const user = await customer();
      const before = (await readCode(user).expect(200)).body.data.code as string;

      await app.get(ReferralSubjectDataContract).eraseSubjectData(dataSource.manager, user.id, tombstoneFor(user.id, ERASED_AT));

      const after = (await readCode(user).expect(200)).body.data.code as string;
      expect(after).not.toBe(before);
    });

    it('reports a truthful count rather than a fabricated one', async () => {
      // V3.2-B bug #3: TypeORM's postgres driver returns `[rows, rowCount]` for
      // DELETE, so `result.length` is 2 for every statement -- an erasure that
      // always claims two rows.
      const empty = await customer();
      const outcome = await app.get(ReferralSubjectDataContract).eraseSubjectData(dataSource.manager, empty.id, tombstoneFor(empty.id, ERASED_AT));
      expect(outcome.deleted).toBe(0);
    });

    it('is reached by the platform\'s real erasure route, not only in isolation', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS, { strict: false });
      // Registered in the composition root's list. Without this the module could
      // pass every test above and still never be called during a real erasure.
      expect(contracts.map((c) => c.moduleKey)).toContain('referral');
    });

    it('FAILS the coverage check when the referral table is unclaimed', async () => {
      // Proved by test rather than by inspection: the coverage check is what
      // stops the boot, so a test that only reads the contract proves nothing
      // about whether the check would fire.
      const coverage = app.get(SubjectDataCoverageService);
      expect(coverage).toBeDefined();

      const withoutReferral: SubjectDataContract[] = [
        {
          moduleKey: 'pretend',
          tables: [],
          exportSubjectData: async () => [],
          eraseSubjectData: async () => ({ moduleKey: 'pretend', anonymized: 0, deleted: 0, retained: [] }),
        },
      ];
      const report = evaluateCoverage(
        [{ schema: 'referral', name: 'referral_codes', columns: ['id', 'owner_user_id', 'code', 'created_at'] }],
        withoutReferral,
      );
      expect(report.violations.some((v) => v.kind === 'unclaimed' && v.table === 'referral.referral_codes')).toBe(true);
    });

    it('REJECTS a no_subject_data claim on the table by column name alone', async () => {
      // The naming convention doing its job. Even if somebody declared the wrong
      // disposition, `owner_user_id` makes the check reject it.
      const wrong: SubjectDataContract[] = [
        {
          moduleKey: 'referral',
          tables: [
            { table: 'referral.referral_codes', disposition: 'no_subject_data', reason: 'just a random string' },
          ],
          exportSubjectData: async () => [],
          eraseSubjectData: async () => ({ moduleKey: 'referral', anonymized: 0, deleted: 0, retained: [] }),
        },
      ];
      const report = evaluateCoverage(
        [{ schema: 'referral', name: 'referral_codes', columns: ['id', 'owner_user_id', 'code', 'created_at'] }],
        wrong,
      );
      expect(report.violations.some((v) => v.kind === 'wrongly_declared_empty')).toBe(true);
    });

    it('FAILS the coverage check if a future table is claimed before it exists', async () => {
      // Why this story claims exactly one table. `referral.referrals` arrives
      // with Story #27; claiming it now would read as coverage while covering
      // nothing.
      const early: SubjectDataContract[] = [
        {
          moduleKey: 'referral',
          tables: [
            { table: 'referral.referral_codes', disposition: 'subject_data' },
            { table: 'referral.referrals', disposition: 'retained', reason: 'explains a retained ledger row' },
          ],
          exportSubjectData: async () => [],
          eraseSubjectData: async () => ({ moduleKey: 'referral', anonymized: 0, deleted: 0, retained: [] }),
        },
      ];
      const report = evaluateCoverage(
        [{ schema: 'referral', name: 'referral_codes', columns: ['id', 'owner_user_id', 'code', 'created_at'] }],
        early,
      );
      expect(
        report.violations.some((v) => v.kind === 'claimed_but_absent' && v.table === 'referral.referrals'),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6. The service surface other stories will build on
  // -------------------------------------------------------------------------

  describe('service surface', () => {
    it('allForSubject returns only the subject\'s rows', async () => {
      const user = await customer();
      const other = await customer();
      await readCode(user).expect(200);
      await readCode(other).expect(200);

      const rows = await referral.allForSubject(dataSource.manager, user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerUserId).toBe(user.id);
    });

    it('codeFor is idempotent when called directly, not only through HTTP', async () => {
      const user = await customer();
      const first = await referral.codeFor(user.id);
      const second = await referral.codeFor(user.id);
      expect(second).toEqual(first);
      expect(await storedCodes(user.id)).toHaveLength(1);
    });
  });
});
