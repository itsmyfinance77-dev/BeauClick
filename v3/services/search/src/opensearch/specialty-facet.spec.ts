import { InMemorySearchEngine } from './in-memory-search.engine';
import type { ProviderSearchDocument } from '../ports';

const SPECIALTY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SPECIALTY_ID = '22222222-2222-4222-8222-222222222222';

function document(
  professionalId: string,
  specialtyId: string,
  specialtyName: string,
): ProviderSearchDocument {
  return {
    professionalId,
    revision: 1,
    displayName: professionalId,
    bio: null,
    cityId: null,
    cityName: null,
    specialtyIds: [specialtyId],
    specialtyNames: [specialtyName],
    verificationStatus: 'verified',
    isVerified: true,
    services: [],
    serviceNames: [],
    minPriceToman: null,
    maxPriceToman: null,
    ratingAvg: 0,
    reviewCount: 0,
    completedBookings: 0,
    rankingScore: 0,
    rankingSignalKeys: [],
    avatarUrl: null,
    avatarWidth: null,
    avatarHeight: null,
    portfolioCount: 0,
    portfolioPreviewUrls: [],
    indexedAt: new Date(0).toISOString(),
  };
}

describe('specialty facet contract', () => {
  it('uses the filterable specialty id as its key and keeps the name as its label', async () => {
    const engine = new InMemorySearchEngine();
    await engine.ensureIndex('providers-v1');
    await engine.indexDocuments('providers-v1', [
      document('one', SPECIALTY_ID, 'میکاپ'),
      document('two', OTHER_SPECIALTY_ID, 'ناخن'),
    ]);
    await engine.swapAlias('providers', 'providers-v1');

    const unfiltered = await engine.search('providers', { sort: 'relevance', page: 1, pageSize: 20 });
    expect(unfiltered.facets.specialties).toContainEqual({
      key: SPECIALTY_ID,
      label: 'میکاپ',
      count: 1,
    });

    const filtered = await engine.search('providers', {
      specialtyIds: [unfiltered.facets.specialties[0].key],
      sort: 'relevance',
      page: 1,
      pageSize: 20,
    });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].specialtyIds).toContain(unfiltered.facets.specialties[0].key);
  });
});
