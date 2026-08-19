/**
 * ADR-010 §2: reference/static data is reseeded, not migrated row-by-row
 * (there is no V2 production dataset to migrate from). A minimal seed set
 * for Phase 1 development/testing -- launched-city and specialty coverage
 * expansion is an operational task, not an architecture one.
 */
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { CityEntity } from '../../services/provider/src/entities/city.entity';
import { SpecialtyEntity } from '../../services/provider/src/entities/specialty.entity';

export async function seedReferenceData(dataSource: DataSource): Promise<void> {
  const cityRepo = dataSource.getRepository(CityEntity);
  const specialtyRepo = dataSource.getRepository(SpecialtyEntity);

  const cityNames = ['یزد', 'تهران', 'اصفهان', 'شیراز', 'مشهد'];
  for (const name of cityNames) {
    const exists = await cityRepo.findOne({ where: { name } });
    if (!exists) {
      await cityRepo.save(cityRepo.create({ id: uuidv7(), name, isLaunched: true }));
    }
  }

  const specialtyNames = ['میکاپ', 'ناخن', 'پوست و مو', 'مژه و ابرو', 'اپیلاسیون'];
  for (const name of specialtyNames) {
    const exists = await specialtyRepo.findOne({ where: { name } });
    if (!exists) {
      await specialtyRepo.save(specialtyRepo.create({ id: uuidv7(), name, parentId: null }));
    }
  }
}
