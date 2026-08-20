import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createRealPostgresDataSource, isRealPostgresConfigured, truncateTables } from '@beauclick/testing';
import { IDENTITY_ENTITIES, UserEntity, RefreshTokenEntity, OtpRequestEntity } from '@beauclick/identity';
import { PROVIDER_ENTITIES, ProfessionalEntity, SpecialtyEntity, CityEntity } from '@beauclick/provider';

/**
 * REAL PostgreSQL integration tests (ADR-015). Unlike the pg-mem suites,
 * these run against the schema the REAL migration files created
 * (database/migrations/**, applied by database/scripts/migrate.ts) with
 * synchronize:false -- so an entity/migration divergence fails here rather
 * than being masked by a regenerated schema.
 *
 * Requires TEST_DATABASE_URL. Run via `pnpm test:pg` (see package.json),
 * which is a separate target from the default suite precisely so the fast
 * pg-mem layer stays runnable without a database.
 */
const describeIfPg = isRealPostgresConfigured() ? describe : describe.skip;

const ALL_TABLES = [
  'provider.professional_specialties',
  'provider.services',
  'provider.professionals',
  'provider.specialties',
  'provider.locations_cities',
  'identity.refresh_tokens',
  'identity.phone_conflicts',
  'identity.otp_requests',
  'identity.users',
];

describeIfPg('Real PostgreSQL integration', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createRealPostgresDataSource([...IDENTITY_ENTITIES, ...PROVIDER_ENTITIES]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await truncateTables(dataSource, ALL_TABLES);
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await truncateTables(dataSource, ALL_TABLES);
  });

  describe('server + schema', () => {
    it('is a genuine PostgreSQL server (not an in-memory emulator)', async () => {
      const [{ version }] = await dataSource.query('SELECT version()');
      expect(version).toMatch(/PostgreSQL/);
      expect(version).not.toMatch(/pg-mem/);
    });

    it('has both migration-created schemas present', async () => {
      const rows = await dataSource.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('identity','provider') ORDER BY schema_name`,
      );
      expect(rows.map((r: { schema_name: string }) => r.schema_name)).toEqual(['identity', 'provider']);
    });

    it('records applied migrations in the tracking table', async () => {
      const rows = await dataSource.query('SELECT filename FROM public.schema_migrations ORDER BY filename');
      const files = rows.map((r: { filename: string }) => r.filename);
      expect(files).toContain('identity/20260820000001_create_identity_schema.sql');
      expect(files).toContain('provider/20260820000002_create_provider_schema.sql');
    });

    it('entity metadata matches the real migration-created columns (the divergence pg-mem could not catch)', async () => {
      // If TypeORM's entity column names diverged from the migration SQL,
      // this query -- built entirely from entity metadata against a
      // synchronize:false schema -- would throw "column does not exist".
      await expect(dataSource.getRepository(UserEntity).find({ take: 1 })).resolves.toBeDefined();
      await expect(dataSource.getRepository(OtpRequestEntity).find({ take: 1 })).resolves.toBeDefined();
      await expect(dataSource.getRepository(RefreshTokenEntity).find({ take: 1 })).resolves.toBeDefined();
      await expect(dataSource.getRepository(ProfessionalEntity).find({ take: 1, relations: ['specialties'] })).resolves.toBeDefined();
    });
  });

  describe('identity persistence', () => {
    it('persists and reads back a user with real timestamptz audit columns', async () => {
      const repo = dataSource.getRepository(UserEntity);
      const id = uuidv7();
      await repo.save(repo.create({ id, phone: '+989120000001', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));

      const found = await repo.findOneOrFail({ where: { id } });
      expect(found.phone).toBe('+989120000001');
      expect(found.roles).toEqual(['customer']); // real Postgres text[] round-trip
      expect(found.createdAt).toBeInstanceOf(Date);
      expect(found.updatedAt).toBeInstanceOf(Date);
    });

    it('enforces the UNIQUE phone constraint at the database level', async () => {
      const repo = dataSource.getRepository(UserEntity);
      await repo.save(repo.create({ id: uuidv7(), phone: '+989120000002', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));

      await expect(
        repo.save(repo.create({ id: uuidv7(), phone: '+989120000002', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null })),
      ).rejects.toThrow();
    });

    it('enforces the refresh_tokens -> users foreign key', async () => {
      const tokenRepo = dataSource.getRepository(RefreshTokenEntity);
      await expect(
        tokenRepo.save(
          tokenRepo.create({
            id: uuidv7(),
            userId: uuidv7(), // no such user
            tokenHash: 'deadbeef',
            deviceLabel: null,
            userAgent: null,
            replacedByTokenId: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() + 86_400_000),
            lastUsedAt: null,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('provider persistence and ownership queries', () => {
    it('persists a professional and resolves it by owner (the ProviderOwnerResolver query path)', async () => {
      const repo = dataSource.getRepository(ProfessionalEntity);
      const ownerId = uuidv7();
      const id = uuidv7();
      await repo.save(repo.create({ id, ownerId, displayName: 'Sara', bio: null, cityId: null, verificationStatus: 'unverified', deletedAt: null, specialties: [] }));

      const byOwner = await repo.findOne({ where: { ownerId } });
      expect(byOwner?.id).toBe(id);
    });

    it('enforces UNIQUE(owner_id) -- one professional profile per identity', async () => {
      const repo = dataSource.getRepository(ProfessionalEntity);
      const ownerId = uuidv7();
      await repo.save(repo.create({ id: uuidv7(), ownerId, displayName: 'First', bio: null, cityId: null, verificationStatus: 'unverified', deletedAt: null, specialties: [] }));

      await expect(
        repo.save(repo.create({ id: uuidv7(), ownerId, displayName: 'Second', bio: null, cityId: null, verificationStatus: 'unverified', deletedAt: null, specialties: [] })),
      ).rejects.toThrow();
    });

    it('round-trips the many-to-many specialties join through the real join table', async () => {
      const specialtyRepo = dataSource.getRepository(SpecialtyEntity);
      const cityRepo = dataSource.getRepository(CityEntity);
      const repo = dataSource.getRepository(ProfessionalEntity);

      const city = await cityRepo.save(cityRepo.create({ id: uuidv7(), name: 'یزد', isLaunched: true }));
      const makeup = await specialtyRepo.save(specialtyRepo.create({ id: uuidv7(), name: 'میکاپ', parentId: null }));
      const nails = await specialtyRepo.save(specialtyRepo.create({ id: uuidv7(), name: 'ناخن', parentId: null }));

      const id = uuidv7();
      await repo.save(
        repo.create({ id, ownerId: uuidv7(), displayName: 'Multi', bio: null, cityId: city.id, verificationStatus: 'unverified', deletedAt: null, specialties: [makeup, nails] }),
      );

      const found = await repo.findOneOrFail({ where: { id }, relations: ['specialties'] });
      expect(found.specialties.map((s) => s.name).sort()).toEqual(['میکاپ', 'ناخن'].sort());
      expect(found.cityId).toBe(city.id);
    });

    it('enforces the professionals -> locations_cities foreign key', async () => {
      const repo = dataSource.getRepository(ProfessionalEntity);
      await expect(
        repo.save(repo.create({ id: uuidv7(), ownerId: uuidv7(), displayName: 'Bad City', bio: null, cityId: uuidv7(), verificationStatus: 'unverified', deletedAt: null, specialties: [] })),
      ).rejects.toThrow();
    });
  });

  describe('UUID behavior', () => {
    it('stores application-generated UUIDv7 values unchanged, and they sort time-ordered', async () => {
      const repo = dataSource.getRepository(UserEntity);
      const first = uuidv7();
      await new Promise((r) => setTimeout(r, 5));
      const second = uuidv7();

      await repo.save(repo.create({ id: first, phone: '+989120000010', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));
      await repo.save(repo.create({ id: second, phone: '+989120000011', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));

      const rows = await repo.find({ order: { id: 'ASC' } });
      expect(rows.map((r) => r.id)).toEqual([first, second]); // UUIDv7's time prefix preserves insertion order
      expect(rows[0].id).toBe(first); // value stored verbatim, not rewritten by the DB
    });

    it('rejects a malformed UUID at the database type level', async () => {
      await expect(dataSource.query(`INSERT INTO identity.users (id, phone, roles) VALUES ('not-a-uuid', '+989120000012', '{customer}')`)).rejects.toThrow();
    });
  });

  describe('transactions and rollback', () => {
    it('rolls back every write in a failed transaction', async () => {
      const repo = dataSource.getRepository(UserEntity);
      const id = uuidv7();

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.save(manager.create(UserEntity, { id, phone: '+989120000020', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));
          throw new Error('deliberate failure after a successful write');
        }),
      ).rejects.toThrow('deliberate failure');

      expect(await repo.findOne({ where: { id } })).toBeNull();
    });

    it('commits every write in a successful transaction', async () => {
      const repo = dataSource.getRepository(UserEntity);
      const id = uuidv7();

      await dataSource.transaction(async (manager) => {
        await manager.save(manager.create(UserEntity, { id, phone: '+989120000021', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));
      });

      expect(await repo.findOne({ where: { id } })).not.toBeNull();
    });

    it('rolls back a constraint violation mid-transaction without persisting the earlier write', async () => {
      const repo = dataSource.getRepository(UserEntity);
      const goodId = uuidv7();
      await repo.save(repo.create({ id: uuidv7(), phone: '+989120000030', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.save(manager.create(UserEntity, { id: goodId, phone: '+989120000031', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));
          // duplicate phone -> real UNIQUE violation inside the same transaction
          await manager.save(manager.create(UserEntity, { id: uuidv7(), phone: '+989120000030', roles: ['customer'], isVerifiedProfessional: false, deletedAt: null, displayName: null }));
        }),
      ).rejects.toThrow();

      expect(await repo.findOne({ where: { id: goodId } })).toBeNull();
    });
  });
});
