/**
 * Runs the repository's OWN reference-data seed (`v3/database/seeds/reference-data.seed.ts`:
 * launched cities and top-level specialties) against the demo database. Nothing is
 * reimplemented here; this only opens a DataSource and calls the seed function.
 *
 * Invoked by demo/scripts/provision-db.mjs with DATABASE_URL = the app role on the
 * demo DB and NODE_PATH = v3/apps/api/node_modules.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { seedReferenceData } from '../../v3/database/seeds/reference-data.seed';
import { CityEntity } from '../../v3/services/provider/src/entities/city.entity';
import { SpecialtyEntity } from '../../v3/services/provider/src/entities/specialty.entity';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !/@127\.0\.0\.1:55432\/beauclick_demo$/.test(url)) {
    throw new Error('Refusing: DATABASE_URL must point at the demo database on 127.0.0.1:55432/beauclick_demo.');
  }
  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: [CityEntity, SpecialtyEntity],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await ds.initialize();
  try {
    await seedReferenceData(ds);
    const cities = await ds.getRepository(CityEntity).count();
    const specialties = await ds.getRepository(SpecialtyEntity).count();
    console.log(`reference data present: ${cities} cities, ${specialties} specialties`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
