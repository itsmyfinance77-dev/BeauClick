// Stage: sellers — two independent professionals and one salon (business) with a
// manager, a practitioner and a finance reader. Everything by self-service or by
// the business owner's own staff actions; invitees accept for themselves.
const items = (d) => (Array.isArray(d) ? d : d?.items ?? d?.value ?? []);

async function professional(s, { displayName, bio, cityId, specialtyIds, services }, log) {
  let me = await s.get('/v1/me/provider', { expect: [200, 404] });
  let providerId = me.status === 200 ? (me.data?.id ?? me.data?.provider?.id) : null;
  if (!providerId) {
    const created = await s.post('/v1/providers', { displayName, bio, cityId, specialtyIds });
    providerId = created.data.id;
    log(`${s.label}: professional profile created`);
  }
  await s.refresh();
  const existing = items((await s.get(`/v1/providers/${providerId}/services`)).data);
  const serviceIds = {};
  for (const svc of services) {
    const found = existing.find((e) => e.name === svc.name);
    serviceIds[svc.key] = found ? found.id : (await s.post(`/v1/providers/${providerId}/services`, { name: svc.name, durationMinutes: svc.durationMinutes, priceToman: svc.priceToman })).data.id;
  }
  return { providerId, serviceIds };
}

export const sellers = {
  name: 'sellers',
  async run({ as, refreshed, state, log }) {
    const anon = await as('cust4');
    const cities = items((await anon.get('/v1/cities')).data);
    const specialties = items((await anon.get('/v1/specialties')).data);
    const city = (n) => cities.find((c) => c.name === n)?.id;
    const spec = (n) => specialties.find((c) => c.name === n)?.id;
    if (!city('تهران') || !spec('میکاپ')) throw new Error('reference data missing');
    state.ids.city = { tehran: city('تهران'), shiraz: city('شیراز'), isfahan: city('اصفهان') };

    // --- pro1: independent make-up artist (will be governed by an outcome policy) ---
    const pro1 = await professional(
      await as('pro1'),
      {
        displayName: 'نگار رحیمی — میکاپ (دمو)',
        bio: 'حساب ساختگی دمو. میکاپ عروس و مجلسی با ۸ سال سابقه (داده‌های نمایشی).',
        cityId: city('تهران'),
        specialtyIds: [spec('میکاپ'), spec('مژه و ابرو')],
        services: [
          { key: 'bridal', name: 'میکاپ عروس', durationMinutes: 120, priceToman: 4_500_000 },
          { key: 'party', name: 'میکاپ مجلسی', durationMinutes: 60, priceToman: 1_800_000 },
          { key: 'brow', name: 'اصلاح و فرم ابرو', durationMinutes: 30, priceToman: 450_000 },
        ],
      },
      log,
    );
    state.ids.pro1 = pro1;

    // --- pro2: independent nail artist (unenrolled: bookable live from the web) ---
    const pro2 = await professional(
      await as('pro2'),
      {
        displayName: 'سارا کریمی — ناخن (دمو)',
        bio: 'حساب ساختگی دمو. کاشت و طراحی ناخن (داده‌های نمایشی).',
        cityId: city('تهران'),
        specialtyIds: [spec('ناخن')],
        services: [
          { key: 'gel', name: 'کاشت ژل', durationMinutes: 90, priceToman: 1_200_000 },
          { key: 'mani', name: 'مانیکور', durationMinutes: 45, priceToman: 380_000 },
        ],
      },
      log,
    );
    state.ids.pro2 = pro2;

    // --- the salon practitioner's own professional profile ---
    const prac = await professional(
      await as('bizPractitioner'),
      {
        displayName: 'مینا احمدی — پوست و مو (دمو)',
        bio: 'حساب ساختگی دمو. کارشناس پوست و مو در سالن نمونه.',
        cityId: city('تهران'),
        specialtyIds: [spec('پوست و مو')],
        services: [
          { key: 'facial', name: 'پاکسازی پوست', durationMinutes: 60, priceToman: 950_000 },
          { key: 'color', name: 'رنگ مو', durationMinutes: 120, priceToman: 2_400_000 },
        ],
      },
      log,
    );
    state.ids.practitioner = prac;

    // --- salon (business) ---
    const owner = await as('bizOwner');
    let biz = await owner.get('/v1/me/business', { expect: [200, 404] });
    let businessId = biz.status === 200 ? (biz.data?.id ?? biz.data?.business?.id) : null;
    if (!businessId) {
      businessId = (await owner.post('/v1/businesses', {
        displayName: 'سالن زیبایی آوا (دمو)',
        bio: 'کسب‌وکار ساختگی دمو با دو شعبه در تهران.',
        cityId: city('تهران'),
      })).data.id;
      log('bizOwner: business created');
    }
    await refreshed('bizOwner');
    state.ids.businessId = businessId;
    await owner.put(`/v1/businesses/${businessId}/classification`, { vertical: 'salon', traits: ['multi_location'] });

    const locs = items((await owner.get(`/v1/businesses/${businessId}/locations`)).data);
    const locRef = async (name) =>
      locs.find((l) => l.name === name)?.locationRef ??
      locs.find((l) => l.name === name)?.ref ??
      (await owner.post(`/v1/businesses/${businessId}/locations`, { name, cityId: city('تهران') })).data.locationRef;
    const main = await locRef('شعبهٔ ونک');
    const second = await locRef('شعبهٔ تجریش');
    state.ids.locations = { main, second };
    const resources = items((await owner.get(`/v1/businesses/${businessId}/locations/${main}/resources`)).data);
    if (!resources.length) {
      await owner.post(`/v1/businesses/${businessId}/locations/${main}/resources`, { name: 'اتاق پوست ۱', kind: 'room' });
      await owner.post(`/v1/businesses/${businessId}/locations/${main}/resources`, { name: 'ایستگاه رنگ ۱', kind: 'station' });
    }

    // --- staff invitations (by phone) and self-acceptance ---
    const invite = async (key, role) => {
      const { persona } = await import('../personas.mjs');
      const res = await owner.post(`/v1/businesses/${businessId}/staff`, { phone: persona(key).phone, role }, { expect: [200, 201, 202, 409] });
      const invitee = await as(key);
      const mine = items((await invitee.get('/v1/me/business-staff')).data);
      const pending = mine.find((m) => (m.businessId ?? m.business?.id) === businessId);
      if (pending && (pending.status ?? '') !== 'active') {
        await invitee.post(`/v1/me/business-staff/${pending.id ?? pending.staffId}/accept`);
      }
      await refreshed(key);
      log(`${key}: invited as ${role} (HTTP ${res.status}) and accepted`);
    };
    await invite('bizManager', 'manager');
    await invite('bizPractitioner', 'staff');
    await invite('financeReader', 'staff');

    const staff = items((await owner.get(`/v1/businesses/${businessId}/staff-management`)).data);
    state.ids.staff = staff.map((m) => ({ id: m.id ?? m.staffId, role: m.role, status: m.status, name: m.displayName ?? m.name }));
    log(`staff: ${JSON.stringify(state.ids.staff)}`);
  },
};
