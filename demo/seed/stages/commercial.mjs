// Stage: commercial policies, published by the ADMINISTRATOR through the admin
// commercial API, and the sellers' own choices through their own routes.
//
// Every value here is SYNTHETIC and labelled so ("ساختگی دمو"): no commercial value
// or legal wording has been approved (V33-DEC-028). No legal evidence is recorded —
// the outcome policy carries no legal cap, so the product shows the cap as absent
// rather than resting on a fabricated legal record.
const items = (d) => (Array.isArray(d) ? d : d?.items ?? d?.value ?? []);
const REASON = 'Synthetic demo configuration for the internal team demo 2026-09-28 (not an approved commercial or legal value)';

async function ensurePublished(admin, root, key, createBody, draftBody, log) {
  const list = items((await admin.get(root)).data);
  const keyField = Object.keys(createBody).find((k) => k.endsWith('Key'));
  if (!list.some((x) => x[keyField] === key)) await admin.post(root, createBody);
  const versions = items((await admin.get(`${root}/${encodeURIComponent(key)}/versions`)).data);
  const live = versions.find((v) => v.lifecycleState === 'published');
  if (live) return live.version;
  const draft = versions.find((v) => v.lifecycleState === 'draft') ?? (await admin.post(`${root}/${encodeURIComponent(key)}/versions`, draftBody)).data;
  const version = draft.version?.version ?? draft.version;
  await admin.post(`${root}/${encodeURIComponent(key)}/versions/${version}/publish`, { reason: REASON });
  log(`published ${root.split('/').pop()} ${key} v${version}`);
  return version;
}

export const commercial = {
  name: 'commercial',
  async run({ as, state, log }) {
    const admin = await as('admin');
    const ROOT = '/v1/admin/commercial';

    const commissionVersion = await ensurePublished(
      admin,
      `${ROOT}/commission-policies`,
      'demo-booking-commission',
      { policyKey: 'demo-booking-commission', component: 'booking_commission', displayName: 'کمیسیون رزرو — ساختگی دمو', reason: REASON },
      { ruleKind: 'percentage', basisPoints: 1000, base: 'service_total', reason: REASON },
      log,
    );

    const outcomeVersion = await ensurePublished(
      admin,
      `${ROOT}/outcome-policies`,
      'demo-outcome-standard',
      { policyKey: 'demo-outcome-standard', displayName: 'سیاست لغو و عدم حضور — ساختگی دمو', reason: REASON },
      {
        cutoffHoursAllowed: [12, 24],
        lateRetentionOptions: [{ kind: 'percentage_of_collected', basisPoints: 2500 }, { kind: 'none' }],
        noShowGraceMinutesAllowed: [5, 15],
        noShowRetentionOptions: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 5000 }],
        rescheduleFreeCountBeforeCutoff: 1,
        disputeWindowHours: 36,
        bodilyHarmWindowHours: null,
        appealWindowHours: 48,
        caseFileRetentionDays: null,
        legalCap: null,
        legalEvidenceKey: null,
        activationEndsAt: null,
        reason: REASON,
      },
      log,
    );

    const copyVersion = await ensurePublished(
      admin,
      `${ROOT}/customer-policy-copies`,
      'demo-customer-terms',
      { copyKey: 'demo-customer-terms', displayName: 'متن شرایط مشتری — نمونهٔ دمو', reason: REASON },
      {
        locale: 'fa-IR',
        body:
          'متن نمونهٔ دمو — این متن حقوقی تأییدشده نیست.\n' +
          'لغو تا ۱۲ ساعت پیش از نوبت رایگان است؛ پس از آن بخشی از مبلغ پرداختی ممکن است طبق سیاست انتخاب‌شدهٔ متخصص نگه داشته شود. ' +
          'عدم حضور پس از مهلت تعیین‌شده ثبت می‌شود و مشتری می‌تواند در بازهٔ اعتراض پاسخ دهد.',
        activationEndsAt: null,
        reason: REASON,
      },
      log,
    );

    state.ids.policies = {
      commission: { key: 'demo-booking-commission', version: commissionVersion },
      outcome: { key: 'demo-outcome-standard', version: outcomeVersion },
      copy: { key: 'demo-customer-terms', version: copyVersion },
    };
  },
};

export const governance = {
  name: 'governance',
  async run({ as, refreshed, state, log }) {
    // pro1 enrolls in the published outcome policy through their own workspace.
    const pro1 = await as('pro1');
    let subs = items((await pro1.get('/v1/me/subscriptions')).data);
    if (!subs.length) {
      await pro1.post('/v1/me/subscriptions/initialization', {});
      subs = items((await pro1.get('/v1/me/subscriptions')).data);
    }
    const ref = subs[0].workspaceRef;
    state.ids.pro1.workspaceRef = ref;
    const selection = {
      cutoffHours: 12,
      lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 2500 },
      noShowGraceMinutes: 5,
      noShowRetention: { kind: 'none' },
    };
    await pro1.put(`/v1/me/outcome-policy-assignments/${encodeURIComponent(ref)}`, {
      policyKey: state.ids.policies.outcome.key,
      ...selection,
      reason: 'انتخاب سیاست توسط متخصص (دمو)',
    });
    const now = await pro1.get(`/v1/me/outcome-policy-assignments/${encodeURIComponent(ref)}`);
    log(`pro1 outcome assignment: ${JSON.stringify(now.data?.assignment ?? now.data).slice(0, 160)}`);

    // The salon owner grants scoped staff roles.
    const owner = await as('bizOwner');
    const bid = state.ids.businessId;
    const staffIdOf = async (key) => {
      const s = await as(key);
      const mine = items((await s.get('/v1/me/business-staff')).data);
      const row = mine.find((m) => (m.businessId ?? m.business?.id) === bid);
      return row?.id ?? row?.staffId;
    };
    const grant = async (key, role) => {
      const staffId = await staffIdOf(key);
      const current = items((await owner.get(`/v1/businesses/${bid}/staff/${staffId}/grants`)).data);
      if (!current.some((g) => g.role === role && !g.revokedAt)) {
        await owner.post(`/v1/businesses/${bid}/staff/${staffId}/grants`, { role });
      }
      await refreshed(key);
      log(`${key}: ${role} granted`);
      return staffId;
    };
    state.ids.staffIds = {
      financeReader: await grant('financeReader', 'finance_read'),
      bizPractitioner: await grant('bizPractitioner', 'practitioner_chat'),
      bizManager: await staffIdOf('bizManager'),
    };
    await owner.put(`/v1/businesses/${bid}/staff/${state.ids.staffIds.bizPractitioner}/location`, { locationRef: state.ids.locations.main });
  },
};
