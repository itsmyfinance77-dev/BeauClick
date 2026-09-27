// Stage: elapsed-time scenarios, produced in REAL time (no backdating seam exists,
// by design). Each professional opens short slots a few minutes ahead, customers
// book and pay through the sandbox bank, and once the slots have actually passed:
//   - pro1 declares a no-show (#161/#212) after the published grace on the DB clock;
//   - sellers complete appointments and customers review them;
//   - the moderator hides one review and publishes another from the queue.
import { checkout } from '../lib/booking-flow.mjs';

const items = (d) => (Array.isArray(d) ? d : d?.items ?? d?.value ?? []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (n) => n * 60_000;

async function ensureShortService(s, ids, log) {
  if (ids.serviceIds.consult) return ids.serviceIds.consult;
  const existing = items((await s.get(`/v1/providers/${ids.providerId}/services`)).data).find((x) => x.name === 'مشاورهٔ کوتاه');
  ids.serviceIds.consult = existing?.id ?? (await s.post(`/v1/providers/${ids.providerId}/services`, { name: 'مشاورهٔ کوتاه', durationMinutes: 15, priceToman: 150_000 })).data.id;
  log(`${s.label}: short consultation service ready`);
  return ids.serviceIds.consult;
}

async function openSlot(s, serviceId, startsInMinutes) {
  const startAt = new Date(Date.now() + minutes(startsInMinutes));
  startAt.setSeconds(0, 0);
  const endAt = new Date(startAt.getTime() + minutes(15));
  const res = await s.post('/v1/me/availability/slots', { startAt: startAt.toISOString(), endAt: endAt.toISOString(), serviceId });
  return { slotId: res.data.id, startAt, endAt };
}

export const elapsed = {
  name: 'elapsed',
  async run({ as, state, log, save }) {
    const e = (state.ids.elapsed ??= {});
    const { pro1, pro2, practitioner } = state.ids;
    const sPro1 = await as('pro1');
    const sPro2 = await as('pro2');
    const sPrac = await as('bizPractitioner');

    if (!e.planned) {
      const c1 = await ensureShortService(sPro1, pro1, log);
      const c2 = await ensureShortService(sPro2, pro2, log);
      const c3 = await ensureShortService(sPrac, practitioner, log);
      const plan = [
        ['E1-no-show-governed', 'cust1', sPro1, pro1, c1, 4, true],
        ['E2-completed-governed', 'cust4', sPro1, pro1, c1, 21, true],
        ['E3-completed-5star', 'cust2', sPro2, pro2, c2, 4, false],
        ['E4-completed-review-hidden', 'cust3', sPro2, pro2, c2, 21, false],
        ['E5-completed-salon', 'cust1', sPrac, practitioner, c3, 5, false],
      ];
      for (const [name, customerKey, seller, ids, serviceId, inMin, governed] of plan) {
        const slot = await openSlot(seller, serviceId, inMin);
        const r = await checkout(await as(customerKey), { professionalId: ids.providerId, serviceId, slotId: slot.slotId, governed });
        e[name] = { ...r, customerKey, sellerKey: seller.label, startAt: slot.startAt.toISOString(), endAt: slot.endAt.toISOString() };
        log(`${name}: slot ${slot.startAt.toISOString()} booked, payment -> ${r.resultLocation?.includes('succeeded') ? 'succeeded' : r.resultLocation}`);
        save();
      }
      e.planned = true;
      save();
    }

    // No-show: permitted at slot_start + grace (5 min, the seller's published selection), on the DB clock.
    const e1 = e['E1-no-show-governed'];
    if (!e1.noShow) {
      const due = Date.parse(e1.startAt) + minutes(5) + 20_000;
      if (Date.now() < due) {
        log(`waiting ${Math.round((due - Date.now()) / 1000)} s for the no-show grace to pass (real time)…`);
        await sleep(due - Date.now());
      }
      const before = await sPro1.get(`/v1/bookings/${e1.bookingId}/no-show`, { expect: [200, 404] });
      log(`E1 no-show read before declaring: ${JSON.stringify(before.data).slice(0, 180)}`);
      await sPro1.post(`/v1/bookings/${e1.bookingId}/no-show`, { statement: 'مشتری تا پایان مهلت حاضر نشد و پاسخ تماس را نداد (سناریوی دمو).' });
      e1.noShow = true;
      save();
      log('E1: no-show declared by the professional');
    }

    // Completion after the appointments have actually ended, then reviews.
    const reviews = {
      'E2-completed-governed': { rating: 5, comment: 'آرایش بسیار حرفه‌ای و دقیق بود. (نظر ساختگی دمو)' },
      'E3-completed-5star': { rating: 5, comment: 'کاشت ناخن عالی و ماندگار؛ محیط تمیز. (نظر ساختگی دمو)' },
      'E4-completed-review-hidden': { rating: 2, comment: 'نظر نمونه برای صف بررسی ناظر — شامل اطلاعات تماس شخصی 0912xxxxxxx (ساختگی دمو)' },
      'E5-completed-salon': { rating: 4, comment: 'پاکسازی پوست خوب بود؛ کمی تأخیر داشت. (نظر ساختگی دمو)' },
    };
    const sellerSession = { pro1: sPro1, pro2: sPro2, bizPractitioner: sPrac };
    for (const [name, review] of Object.entries(reviews)) {
      const b = e[name];
      if (!b.completed) {
        const due = Date.parse(b.endAt) + 10_000;
        if (Date.now() < due) {
          log(`waiting ${Math.round((due - Date.now()) / 1000)} s for ${name} to end (real time)…`);
          await sleep(due - Date.now());
        }
        await sellerSession[b.sellerKey].post(`/v1/bookings/${b.bookingId}/complete`);
        b.completed = true;
        save();
        log(`${name}: completed by the seller`);
      }
      if (!b.reviewed) {
        const r = await (await as(b.customerKey)).post(`/v1/bookings/${b.bookingId}/review`, review);
        b.reviewed = true;
        b.reviewId = r.data?.id;
        save();
        log(`${name}: reviewed ${review.rating}★`);
      }
    }

    // Seller reply and moderation.
    const reply = e['E3-completed-5star'];
    if (reply.reviewId && !reply.replied) {
      await sPro2.post(`/v1/providers/${pro2.providerId}/reviews/${reply.reviewId}/respond`, { text: 'ممنون از لطف شما؛ منتظر دیدار دوباره هستیم. (پاسخ ساختگی دمو)' });
      reply.replied = true;
      log('E3: professional replied to the review');
    }
    const mod = await as('moderator');
    const queue = items((await mod.get('/v1/admin/reviews/queue?page=1&limit=20')).data);
    log(`moderation queue: ${queue.length} review(s)`);
    const hideTarget = e['E4-completed-review-hidden'];
    if (hideTarget.reviewId && !hideTarget.hidden) {
      await mod.post(`/v1/admin/reviews/${hideTarget.reviewId}/moderate`, { decision: 'hide', reason: 'درج اطلاعات تماس شخصی در متن نظر (سناریوی دمو)' });
      hideTarget.hidden = true;
      log('E4: review hidden by the moderator');
    }
  },
};
