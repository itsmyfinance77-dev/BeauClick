// Stage: the rest of the built surface, each action by the persona who would take it.
//   media (synthetic images) + portfolio/avatar/cover, verification submissions and
//   decisions, a media abuse report, wishlist, referral, journey, AI assistant
//   (deterministic provider, consent first), chat (+ a report), waitlist,
//   notification preferences, a privacy export, and an admin settlement.
// Individual items that the product refuses are logged with the refusal code rather
// than retried around — a refusal is a product answer, recorded as evidence.
import { rawRequest } from '../lib/client.mjs';
import { syntheticPng } from '../lib/png.mjs';

const items = (d) => (Array.isArray(d) ? d : d?.items ?? d?.value ?? []);

async function uploadImage(s, purpose, w, h, palette, seed) {
  const png = syntheticPng(w, h, palette, seed);
  const grant = (await s.post('/v1/media/upload-url', { purpose, contentType: 'image/png', byteSize: png.length })).data;
  const url = new URL(grant.upload.url, s.origin).toString();
  const put = await rawRequest(url, { method: grant.upload.method ?? 'PUT', headers: { ...(grant.upload.headers ?? {}), 'content-type': 'image/png' }, body: png });
  if (put.status >= 300) throw new Error(`upload PUT ${put.status}`);
  await s.post(`/v1/media/${grant.mediaId}/finalize`);
  return grant.mediaId;
}

async function attempt(log, label, fn) {
  try {
    const r = await fn();
    log(`${label}: ok${r ? ` ${typeof r === 'string' ? r : JSON.stringify(r).slice(0, 140)}` : ''}`);
    return r;
  } catch (e) {
    log(`${label}: REFUSED/ERROR ${e.message?.slice(0, 200)}`);
    return null;
  }
}

export const engagement = {
  name: 'engagement',
  async run({ as, state, log }) {
    const g = (state.ids.engagement ??= {});
    const { pro1, pro2, practitioner, businessId } = state.ids;
    const P = { rose: [[244, 214, 222], [183, 110, 140]], sand: [[245, 230, 205], [196, 150, 100]], teal: [[210, 236, 236], [70, 140, 150]] };

    // --- media: portfolio, avatar, cover (synthetic images) ---
    const sPro1 = await as('pro1');
    const sPro2 = await as('pro2');
    const sPrac = await as('bizPractitioner');
    if (!g.media) {
      g.media = {};
      for (const [s, ids, pal, n] of [[sPro1, pro1, P.rose, 3], [sPro2, pro2, P.sand, 2], [sPrac, practitioner, P.teal, 1]]) {
        const key = s.label;
        g.media[key] = [];
        for (let k = 0; k < n; k++) {
          const mediaId = await attempt(log, `${key} portfolio image ${k + 1}`, async () => {
            const id = await uploadImage(s, 'portfolio', 800, 600, pal, k + 1);
            await s.post(`/v1/providers/${ids.providerId}/portfolio`, { mediaId: id, caption: `نمونه‌کار ساختگی ${k + 1} (تصویر تولیدشده برای دمو)` });
            return id;
          });
          if (mediaId) g.media[key].push(mediaId);
        }
        await attempt(log, `${key} avatar`, async () => {
          const id = await uploadImage(s, 'avatar', 400, 400, pal, 9);
          await s.patch(`/v1/providers/${ids.providerId}/avatar`, { mediaId: id });
        });
        await attempt(log, `${key} cover`, async () => {
          const id = await uploadImage(s, 'cover', 1200, 480, pal, 5);
          await s.patch(`/v1/providers/${ids.providerId}/cover`, { mediaId: id });
        });
      }
    }

    // --- verification: pro1 approved, pro2 left pending in the queue, practitioner rejected ---
    if (!g.verification) {
      for (const s of [sPro1, sPro2, sPrac]) {
        await attempt(log, `${s.label} verification submission`, async () => {
          const id = await uploadImage(s, 'verification_evidence', 1000, 700, P.teal, 3);
          await s.post('/v1/verification/evidence', { mediaId: id });
          return (await s.post('/v1/verification/submit', { note: 'مدرک نمونهٔ ساختگی برای دمو — سند واقعی نیست.' })).data?.status;
        });
      }
      const mod = await as('moderator');
      const queue = items((await mod.get('/v1/admin/verification/queue?page=1&limit=20')).data);
      log(`verification queue: ${queue.length}`);
      const byProvider = (pid) => queue.find((q) => q.professionalId === pid || q.providerId === pid || q.professional?.id === pid);
      const r1 = byProvider(pro1.providerId);
      if (r1) await attempt(log, 'moderator approves pro1', () => mod.post(`/v1/admin/verification/${r1.id}/decide`, { decision: 'approve', reason: 'مدارک نمونه بررسی شد (سناریوی دمو).' }));
      const r3 = byProvider(practitioner.providerId);
      if (r3) await attempt(log, 'moderator rejects practitioner', () => mod.post(`/v1/admin/verification/${r3.id}/decide`, { decision: 'reject', reason: 'تصویر مدرک خوانا نیست؛ لطفاً دوباره بارگذاری کنید (سناریوی دمو).' }));
      g.verification = true;
    }

    // --- media abuse report (left pending for the moderation demo) ---
    if (!g.mediaReport && g.media?.pro2?.[0]) {
      const c2 = await as('cust2');
      await attempt(log, 'cust2 reports a portfolio image', () => c2.post(`/v1/media/${g.media.pro2[0]}/report`, { reason: 'not_own_work', note: 'به نظرم این تصویر کار خود متخصص نیست (گزارش ساختگی دمو).' }));
      g.mediaReport = true;
    }

    // --- wishlist, journey, referral, notifications ---
    const c1 = await as('cust1');
    if (!g.customer1) {
      await attempt(log, 'cust1 wishlist pro1', () => c1.post('/v1/me/wishlist/items', { targetType: 'professional', targetId: pro1.providerId }));
      await attempt(log, 'cust1 wishlist practitioner', () => c1.post('/v1/me/wishlist/items', { targetType: 'professional', targetId: practitioner.providerId }));
      await attempt(log, 'cust1 wishlist service', () => c1.post('/v1/me/wishlist/items', { targetType: 'service', targetId: pro2.serviceIds.gel }));
      await attempt(log, 'cust1 journey profile', () => c1.patch('/v1/me/journey/profile', { preferredCityId: state.ids.city.tehran, budgetMinToman: 500_000, budgetMaxToman: 5_000_000, notes: 'یادداشت خصوصی ساختگی دمو' }));
      await attempt(log, 'cust1 journey goal', () => c1.post('/v1/me/journey/goals', { title: 'آماده‌شدن برای مراسم عروسی (هدف ساختگی)', budgetToman: 6_000_000, targetDate: '2026-10-20' }));
      await attempt(log, 'cust1 notification preferences', async () => {
        const prefs = items((await c1.get('/v1/me/notifications/preferences')).data?.preferences ?? (await c1.get('/v1/me/notifications/preferences')).data);
        return prefs.length;
      });
      const code = await attempt(log, 'cust1 referral code', async () => (await c1.get('/v1/me/referral/code')).data?.code);
      if (code) {
        for (const k of ['bizManager', 'cust4']) {
          const r = await attempt(log, `${k} claims cust1's referral code`, async () => (await (await as(k)).post('/v1/me/referral/claim', { code })).data);
          if (r) break;
        }
      }
      g.customer1 = true;
    }

    // --- AI assistant (deterministic provider; one-time recorded consent first) ---
    if (!g.ai) {
      await attempt(log, 'cust1 AI consent', () => c1.post('/v1/me/ai/consent'));
      const conv = await attempt(log, 'cust1 AI conversation', async () => (await c1.post('/v1/me/ai/conversations')).data?.id);
      if (conv) await attempt(log, 'cust1 AI message', async () => JSON.stringify((await c1.post(`/v1/me/ai/conversations/${conv}/messages`, { body: 'برای مراسم عروسی در تهران چه خدمات آرایشی پیشنهاد می‌کنی؟' })).data).slice(0, 160));
      g.ai = true;
    }

    // --- chat ---
    if (!g.chat) {
      const c = await attempt(log, 'cust1 opens chat with pro1', async () => (await c1.post('/v1/chat/conversations', { counterpartyType: 'professional', counterpartyId: pro1.providerId })).data);
      const cid = c?.id ?? c?.conversationId;
      if (cid) {
        const { randomUUID } = await import('node:crypto');
        await attempt(log, 'cust1 message', () => c1.post(`/v1/chat/conversations/${cid}/messages`, { body: 'سلام، برای میکاپ عروس در تاریخ ۲۹ مهر وقت دارید؟ (پیام ساختگی)', idempotencyKey: randomUUID() }));
        await attempt(log, 'pro1 reply', () => sPro1.post(`/v1/chat/conversations/${cid}/messages`, { body: 'سلام، بله؛ از صفحهٔ رزرو نوبت را انتخاب کنید. (پاسخ ساختگی)', idempotencyKey: randomUUID() }));
      }
      const c2 = await as('cust2');
      const b = await attempt(log, 'cust2 opens chat with the salon', async () => (await c2.post('/v1/chat/conversations', { counterpartyType: 'business', counterpartyId: businessId })).data);
      const bid = b?.id ?? b?.conversationId;
      if (bid) {
        const { randomUUID } = await import('node:crypto');
        await attempt(log, 'cust2 message to salon', () => c2.post(`/v1/chat/conversations/${bid}/messages`, { body: 'آیا شعبهٔ تجریش هم پاکسازی پوست انجام می‌دهد؟ (پیام ساختگی)', idempotencyKey: randomUUID() }));
        const mgr = await as('bizManager');
        await attempt(log, 'salon manager reply', () => mgr.post(`/v1/chat/conversations/${bid}/messages`, { body: 'بله، از هفتهٔ آینده. (پاسخ ساختگی مدیر شعبه)', idempotencyKey: randomUUID() }));
      }
      const c3 = await as('cust3');
      const r = await attempt(log, 'cust3 opens chat with pro2', async () => (await c3.post('/v1/chat/conversations', { counterpartyType: 'professional', counterpartyId: pro2.providerId })).data);
      const rid = r?.id ?? r?.conversationId;
      if (rid) {
        const { randomUUID } = await import('node:crypto');
        const sent = await attempt(log, 'cust3 off-platform payment message', async () => (await c3.post(`/v1/chat/conversations/${rid}/messages`, { body: 'بیا بیرون از سایت کارت‌به‌کارت کنیم ارزان‌تر شود (پیام ساختگی برای گزارش).', idempotencyKey: randomUUID() })).data);
        const messageId = sent?.message?.id ?? sent?.id;
        if (messageId) await attempt(log, 'pro2 reports the message', () => sPro2.post(`/v1/chat/conversations/${rid}/report`, { messageId, reason: 'off_platform_payment', note: 'درخواست پرداخت خارج از سامانه (گزارش ساختگی)' }));
      }
      g.chat = true;
    }

    // --- waitlist, privacy export ---
    if (!g.misc) {
      const c4 = await as('cust4');
      await attempt(log, 'cust4 joins pro1 waitlist', () => c4.post('/v1/waitlist', { professionalId: pro1.providerId, serviceId: pro1.serviceIds.bridal }));
      const c3 = await as('cust3');
      await attempt(log, 'cust3 requests a data export', () => c3.post('/v1/privacy/export'));
      g.misc = true;
    }

    // --- admin settlement for pro2's completed, paid orders ---
    if (!g.settlement) {
      const admin = await as('admin');
      const out = await attempt(log, 'admin: pro2 outstanding orders', async () => (await admin.get(`/v1/admin/finance/parties/outstanding-orders?partyType=professional&partyId=${pro2.providerId}`)).data);
      const orderIds = items(out).map((o) => o.orderId ?? o.id).filter(Boolean);
      if (orderIds.length) {
        await attempt(log, `admin records a settlement for ${orderIds.length} order(s)`, () =>
          admin.post('/v1/admin/finance/settlements', { partyType: 'professional', partyId: pro2.providerId, orderIds: orderIds.slice(0, 1), method: 'bank_transfer', reference: 'DEMO-SANDBOX-0001', note: 'تسویهٔ ساختگی دمو — هیچ پولی جابه‌جا نشده است.' }),
        );
      }
      g.settlement = true;
    }
  },
};
