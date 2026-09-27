#!/usr/bin/env node
// Browser FLOWS: features exercised through the real UI (not just rendered), each followed by
// persistence (reload + read-only DB), the counterpart role's view, and a denied path.
//
//   node demo/verify/browser-flows.mjs --profile L --group checkout[,account,...]
//
// Real Edge per persona (lib/edge.mjs): real OTP sign-in, real clicks and typing, TLS validated by
// the browser against the Windows trust store. API calls appear ONLY in `denied` checks (a foreign
// persona attempting the action directly), never to perform the feature itself.
import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_ROOT, STATE_DIR } from '../scripts/lib/demo-config.mjs';
import { q } from './lib/db-readonly.mjs';
import { personaBrowser, sleep } from './lib/edge.mjs';
import { recorder } from './lib/flow-record.mjs';
import { personaSession } from './lib/persona-session.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const profileKey = arg('--profile') ?? 'L';
const groups = (arg('--group') ?? 'checkout').split(',');
const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8'));
const ids = state.ids;
const OUT = path.join(RUNTIME_ROOT, 'evidence', `flows-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'README.txt'), 'Browser FLOW evidence (actions taken in the UI). Screenshots are step evidence, not fallback material.\n');
const rec = recorder(OUT);
// --flows "a,b": run only flows whose name contains one of these (re-running after a fix without
// repeating the ones that passed and consumed their data).
const onlyFlows = arg('--flows')?.split(',');
const flow = (name, fn) => (!onlyFlows || onlyFlows.some((f) => name.includes(f)) ? rec.flow(name, fn) : Promise.resolve());

const browsers = new Map();
async function as(key, width = 1280) {
  if (!browsers.has(key)) browsers.set(key, await personaBrowser(key, { profileKey, outDir: OUT }));
  const p = browsers.get(key);
  await p.viewport(width);
  return p;
}
const api = new Map();
const apiAs = async (key) => (api.has(key) ? api.get(key) : (api.set(key, await personaSession(profileKey, key)), api.get(key)));

/** Visible time buttons (Persian HH:MM) on the provider page, in order. */
const timeButtons = (p) => p.evaluate(`[...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && /^[۰-۹]{2}:[۰-۹]{2}$/.test(b.innerText.trim()); }).map((b) => b.innerText.trim())`);
const dayButtons = (p) => p.evaluate(`[...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && /زمان$/.test(b.innerText.replace(/\\s+/g, ' ').trim()); }).map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`);
const orderIdFrom = (url) => new URL(url).searchParams.get('orderId');
const bookingOfOrder = async (orderId) => (await q(`select source_id from commerce.orders where id = $1`, [orderId]))[0]?.source_id;

/** Provider page → service → a day → the last free time → "ادامه به پرداخت". Returns the chosen label. */
async function startCheckout(p, providerId, serviceLabelPrefix, { dayIndex = 1, acceptTerms = false } = {}) {
  await p.goto(`/providers/${providerId}`);
  if (serviceLabelPrefix) await p.click(serviceLabelPrefix, { prefix: true });
  const days = await dayButtons(p);
  await p.click(days[Math.min(dayIndex, days.length - 1)]);
  const times = await timeButtons(p);
  const time = times.at(-1);
  await p.click(time);
  await sleep(1200);
  if (acceptTerms) await p.click('این شرایط را خواندم و می‌پذیرم.');
  await p.click('ادامه به پرداخت');
  await p.waitText('درگاه پرداخت آزمایشی');
  return { day: days[Math.min(dayIndex, days.length - 1)], time };
}

// ============================================================================ checkout
async function checkoutGroup() {
  // --- declined → retry → success (cust2 → pro2, ungoverned) --------------------------
  let paidBooking;
  let paidOrder;
  let paidChosen;
  await flow('checkout: declined, then retry', async (r) => {
    const c = await as('cust2');
    const chosen = await startCheckout(c, ids.pro2.providerId, null, { dayIndex: 2 });
    await c.click('پرداخت ناموفق (رد شده توسط بانک)');
    await c.waitText('تلاش دوباره');
    const failedUrl = await c.url();
    r('ui', 'declined payment lands on the failed result page with a retry', /status=failed/.test(failedUrl) && /reason=declined/.test(failedUrl), failedUrl.replace(c.origin, ''));
    await c.shot('checkout-declined-1280');
    paidOrder = orderIdFrom(failedUrl);
    await c.click('تلاش دوباره');
    await c.waitText('درگاه پرداخت آزمایشی');
    r('ui', 'retry opens the bank again', await c.has('پرداخت موفق'));
    await c.click('پرداخت موفق');
    await c.waitText('پرداخت انجام شد');
    const okUrl = await c.url();
    r('ui', 'retry succeeds and the booking is confirmed', /status=succeeded/.test(okUrl) && (await c.has('رزرو شما تأیید شد')), okUrl.replace(c.origin, ''));
    await c.shot('checkout-retry-succeeded-1280');
    paidBooking = await bookingOfOrder(paidOrder);
    const attempts = await q(`select a.status from payment.payment_attempts a join payment.payment_intents i on i.id = a.payment_intent_id where i.order_id = $1 order by a.created_at`, [paidOrder]);
    const order = (await q(`select status, total_toman from commerce.orders where id = $1`, [paidOrder]))[0];
    r('persist', 'DB: one order, a declined attempt then a successful one, order paid', order?.status === 'paid' && attempts.length >= 2 && attempts.some((a) => /fail|declin/.test(a.status)) && attempts.at(-1).status === 'succeeded', { order, attempts: attempts.map((a) => a.status) });
    await c.goto('/bookings');
    r('persist', 'after a reload the booking is listed as confirmed', (await c.has(chosen.time)) && (await c.has('تأیید شده')), chosen);
    const pro = await as('pro2');
    await pro.goto('/pro/bookings');
    const b = (await q(`select slot_start from booking.bookings where id = $1`, [paidBooking]))[0];
    paidChosen = chosen;
    const weekday = chosen.day.split(' ')[0];
    r('other', 'the professional sees the new booking in their upcoming list (weekday + time)', await pro.evaluate(`(document.querySelector('main')?.innerText ?? '').split('\\n').some((l, i, a) => l.includes(${JSON.stringify(weekday)}) && a.slice(i, i + 6).join(' ').includes(${JSON.stringify(chosen.time)}))`), { booking: paidBooking, start: b?.slot_start });
    await pro.shot('pro2-upcoming-1280');
  });

  // --- cancelled at the bank ----------------------------------------------------------
  await flow('checkout: cancelled at the bank', async (r) => {
    const c = await as('cust2');
    await startCheckout(c, ids.pro2.providerId, null, { dayIndex: 3 });
    await c.click('انصراف از پرداخت');
    await sleep(1500);
    await c.idle();
    const u = await c.url();
    r('ui', 'cancelling at the bank lands on the failed result page (cancelled by user)', /status=failed/.test(u) && /reason=cancelled_by_user/.test(u), u.replace(c.origin, ''));
    await c.shot('checkout-cancelled-1280');
    const order = (await q(`select status from commerce.orders where id = $1`, [orderIdFrom(u)]))[0];
    r('persist', 'DB: the order is not paid', order && order.status !== 'paid', order);
  });

  // --- customer cancels the paid booking (timely → full refund) ------------------------
  await flow('cancellation: customer cancels in the UI', async (r) => {
    if (!paidBooking) throw new Error('needs the paid booking from the previous flow');
    const c = await as('cust2');
    await c.goto('/bookings');
    await c.click('لغو رزرو', { within: `li[data-booking="${paidBooking}"]` });
    await c.waitText('بله، لغو کن');
    await c.click('بله، لغو کن');
    await sleep(1500);
    const status = (await q(`select status from booking.bookings where id = $1`, [paidBooking]))[0]?.status;
    const refunds = await q(`select amount_toman, status, kind from payment.refunds where order_id = $1`, [paidOrder]);
    const total = (await q(`select total_toman from commerce.orders where id = $1`, [paidOrder]))[0]?.total_toman;
    r('persist', 'DB: booking cancelled and a full refund recorded', status === 'cancelled' && refunds.some((x) => String(x.amount_toman) === String(total)), { status, refunds, total });
    await c.goto('/bookings');
    await c.click('گذشته');
    r('persist', 'after a reload the booking shows as cancelled', await c.evaluate(`document.querySelector('li[data-booking="${paidBooking}"]')?.innerText.includes('لغو شده') ?? false`));
    const pro = await as('pro2');
    await pro.goto('/pro/bookings');
    await pro.click('لغوشده', { prefix: true });
    // Pro rows carry no id in the DOM: match this booking's weekday + time inside the cancelled list.
    const weekday = paidChosen.day.split(' ')[0];
    r('other', "the professional's cancelled tab lists it (weekday + time)", await pro.evaluate(`(document.querySelector('main')?.innerText ?? '').split('\\n').some((l, i, a) => l.includes(${JSON.stringify(weekday)}) && a.slice(i, i + 6).join(' ').includes(${JSON.stringify(paidChosen.time)}))`), paidChosen);
    await pro.shot('pro2-cancelled-tab-1280');
    const foreign = await (await apiAs('cust3')).post(`/v1/bookings/${paidBooking}/cancel`, {}, { expect: [200, 201, 400, 403, 404, 409] });
    r('denied', "another customer cannot cancel it through the API", [403, 404].includes(foreign.status), `HTTP ${foreign.status}`);
  });

  // --- A at 390 (cust3 → pro1, governed) -------------------------------------------------
  await flow('A at 390: accept terms, pay, see accepted terms', async (r) => {
    const c = await as('cust3', 390);
    await c.goto(`/providers/${ids.pro1.providerId}`);
    await c.click('میکاپ مجلسی', { prefix: true });
    const days = await dayButtons(c);
    await c.click(days[3] ?? days.at(-1));
    const time = (await timeButtons(c)).at(-2);
    await c.click(time);
    await sleep(1500);
    const before = await c.evaluate(`({ checked: document.querySelector('input[type=checkbox]')?.checked ?? null, pay: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('ادامه به پرداخت'))?.disabled ?? null })`);
    r('ui', 'terms shown unticked and payment closed (390)', before.checked === false && before.pay === true, before);
    await c.shot('A-390-terms-unticked');
    await c.click('این شرایط را خواندم و می‌پذیرم.');
    r('ui', 'ticking opens payment (390)', (await c.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('ادامه به پرداخت'))?.disabled`)) === false);
    r('ui', 'no horizontal overflow on the checkout (390)', (await c.overflow()).scrollW <= 390, await c.overflow());
    await c.click('ادامه به پرداخت');
    await c.waitText('پرداخت موفق');
    await c.click('پرداخت موفق');
    await c.waitText('پرداخت انجام شد');
    const orderId = orderIdFrom(await c.url());
    const bookingId = await bookingOfOrder(orderId);
    r('ui', 'paid and confirmed (390)', await c.has('رزرو شما تأیید شد'));
    const terms = await q(`select t.* from commerce.order_outcome_terms t where t.order_id = $1`, [orderId]);
    r('persist', 'DB: the accepted terms snapshot exists for this order', terms.length === 1, terms[0] ? Object.keys(terms[0]).slice(0, 6) : 'none');
    await c.goto('/bookings');
    await c.click('شرایط پذیرفته‌شده', { within: `li[data-booking="${bookingId}"]` });
    await sleep(1500);
    const shown = await c.evaluate(`document.querySelector('li[data-booking="${bookingId}"]')?.innerText ?? ''`);
    r('persist', 'after a reload "شرایط پذیرفته‌شده" shows the versions (390)', /نسخهٔ سیاست/.test(shown) && /پذیرفته‌شده در/.test(shown));
    r('ui', 'no horizontal overflow on bookings with terms open (390)', (await c.overflow()).scrollW <= 390, await c.overflow());
    await c.shot('A-390-accepted-terms');
    const pro = await as('pro1');
    await pro.goto('/pro/bookings');
    r('other', 'pro1 sees the booking', await pro.has(time), time);
    const foreign = await (await apiAs('cust2')).get(`/v1/bookings/${bookingId}/accepted-terms`, { expect: [200, 403, 404] });
    r('denied', "another customer cannot read the accepted terms", foreign.status === 404, `HTTP ${foreign.status}`);
  });

  // --- B at 390: use an open offer (cust4) --------------------------------------------------
  // Currently open offers owned by a persona; the one to USE must have an active service.
  const userKey = Object.fromEntries(Object.entries(ids).filter(([k]) => k.startsWith('user:')).map(([k, v]) => [v, k.slice(5)]));
  const open = (await q(`select o.original_booking_id id, b.customer_id, s.deleted_at is null as active from commerce.replacement_offers o join booking.bookings b on b.id = o.original_booking_id join provider.services s on s.id = o.service_id where o.status = 'open' order by o.offered_at`)).map((o) => ({ ...o, key: userKey[o.customer_id] })).filter((o) => o.key);
  const use = open.find((o) => o.active);
  const dis = open.find((o) => o !== use);
  const offerUse = use?.id;
  const offerDismiss = dis?.id;
  console.log(`offers: use ${offerUse} (${use?.key}), dismiss ${offerDismiss} (${dis?.key})`);
  await flow('B at 390: use the replacement offer', async (r) => {
    if (!offerUse) throw new Error('no open, eligible offer owned by a persona');
    const c = await as(use.key, 390);
    await c.goto('/bookings');
    await c.click('گذشته');
    const card = `li[data-booking="${offerUse}"]`;
    await c.click('پیشنهاد جایگزینی', { within: card });
    await c.waitText('پیشنهاد رزرو جایگزین');
    const radios = await c.evaluate(`[...document.querySelectorAll('${card} input[type=radio]')].map((x) => x.closest('label').innerText.trim())`);
    await c.click(radios.at(-1), { within: card, selector: 'label', nth: radios.length - 1 });
    await sleep(1500);
    const before = await c.evaluate(`({ checked: document.querySelector('${card} input[type=checkbox]')?.checked ?? null, pay: document.querySelector('${card} [data-testid=replacement-pay]')?.disabled ?? null })`);
    r('ui', 'new terms unticked and payment closed (390)', before.checked === false && before.pay === true, before);
    await c.click('این شرایط را خواندم و می‌پذیرم.', { within: card });
    await c.shot('B-390-offer-terms');
    r('ui', 'no horizontal overflow with the offer open (390)', (await c.overflow()).scrollW <= 390, await c.overflow());
    await c.click('پرداخت و ثبت رزرو جایگزین', { within: card });
    await c.waitText('پرداخت موفق');
    await c.click('پرداخت موفق');
    await c.waitText('پرداخت انجام شد');
    r('ui', 'replacement paid and confirmed (390)', await c.has('رزرو شما تأیید شد'));
    // DEMO-DEC-001: `used` is DERIVED from a linked attempt booking with confirmed_at; the status column
    // is settled on the next read of the offer. Check the truth first, then the settled row after a read.
    const truth = await q(`select b.id, b.status, b.confirmed_at is not null as confirmed from commerce.replacement_offer_attempts a join booking.bookings b on b.id = a.booking_id where a.original_booking_id = $1`, [offerUse]);
    const orig = (await q(`select status from booking.bookings where id = $1`, [offerUse]))[0];
    r('persist', 'DB: exactly one linked attempt booking, confirmed; original stays cancelled', truth.filter((t) => t.confirmed).length === 1 && orig?.status === 'cancelled', { truth, orig });
    await c.goto('/bookings');
    await c.click('گذشته');
    await c.click('پیشنهاد جایگزینی', { within: card });
    r('persist', 'after a reload the panel says the replacement was booked', await c.waitText('رزرو جایگزین ثبت شد'));
    const settled = (await q(`select status, replacement_booking_id from commerce.replacement_offers where original_booking_id = $1`, [offerUse]))[0];
    r('persist', 'DB: after that read the offer row is settled to used by that booking', settled?.status === 'used' && truth.some((t) => t.id === settled.replacement_booking_id && t.confirmed), settled);
    await c.shot('B-390-used');
    const foreign = await (await apiAs('cust2')).get(`/v1/bookings/${offerUse}/replacement-offer`, { expect: [200, 403, 404] });
    r('denied', "another customer cannot see the offer", foreign.status === 404, `HTTP ${foreign.status}`);
  });

  await flow('B: dismiss the offer in the UI', async (r) => {
    if (!offerDismiss) throw new Error('no second open offer owned by a persona');
    const c = await as(dis.key, 1280);
    await c.goto('/bookings');
    await c.click('گذشته');
    const card = `li[data-booking="${offerDismiss}"]`;
    await c.click('پیشنهاد جایگزینی', { within: card });
    await c.waitText('انصراف از پیشنهاد');
    await c.click('انصراف از پیشنهاد', { within: card });
    r('ui', 'dismiss asks for confirmation and says the refund continues', await c.has('بازپرداخت ادامه دارد'));
    await c.click('بله، انصراف می‌دهم', { within: card });
    await sleep(1500);
    const offer = (await q(`select status from commerce.replacement_offers where original_booking_id = $1`, [offerDismiss]))[0];
    const order = (await q(`select o.refunded_total_toman, o.total_toman from commerce.orders o where o.source_id = $1`, [offerDismiss]))[0];
    r('persist', 'DB: offer dismissed; the refund is untouched', offer?.status === 'dismissed' && String(order?.refunded_total_toman) === String(order?.total_toman), { offer, order });
    await c.goto('/bookings');
    await c.click('گذشته');
    await c.click('پیشنهاد جایگزینی', { within: card });
    await sleep(1500);
    const txt = await c.evaluate(`document.querySelector('${card}')?.innerText ?? ''`);
    r('persist', 'after a reload no booking control is offered', !txt.includes('پرداخت و ثبت رزرو جایگزین'), txt.slice(-160));
    await c.shot('B-1280-dismissed');
  });
}

/** Marks the first element matching `rowSelector` whose text contains every string in `texts`; returns its CSS scope. */
async function markRow(p, rowSelector, texts) {
  const ok = await p.evaluate(`(() => { document.querySelectorAll('[data-flow-row]').forEach((e) => e.removeAttribute('data-flow-row'));
    const want = ${JSON.stringify(texts)};
    const el = [...document.querySelectorAll(${JSON.stringify(rowSelector)})].find((e) => want.every((t) => e.innerText.includes(t)));
    if (!el) return false; el.setAttribute('data-flow-row', '1'); return true; })()`);
  return ok ? '[data-flow-row="1"]' : null;
}
/** Clicks whichever confirmation a dialog offers among `labels` (dialogs differ per page). */
async function confirmAny(p, labels) {
  for (const l of labels) {
    if (await p.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === ${JSON.stringify(l)} && b.getBoundingClientRect().width > 0)`)) {
      await p.click(l);
      return l;
    }
  }
  return null;
}
const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
/** Tehran wall-clock parts for an instant: { date: 'YYYY-MM-DD', time: 'HH:MM' }. */
function tehran(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const activeTokens = async (userId) => Number((await q(`select count(*) n from identity.refresh_tokens where user_id = $1 and revoked_at is null and replaced_by_token_id is null and expires_at > now()`, [userId]))[0].n);

// ============================================================================ account
async function accountGroup() {
  await flow('account: sign out', async (r) => {
    const c = await as('cust1');
    await c.goto('/dashboard');
    const before = await activeTokens(ids['user:cust1']);
    await c.click('خروج از حساب');
    await sleep(2000);
    await c.idle();
    const after = await activeTokens(ids['user:cust1']);
    r('ui', 'signing out leaves the account area', (await c.path()) !== '/dashboard', await c.path());
    r('persist', 'DB: this session is revoked server-side (one active session fewer)', after === before - 1, { before, after });
    await c.goto('/bookings');
    r('persist', 'after sign-out a protected page asks to sign in again', (await c.path()) === '/auth', await c.path());
    await c.shot('account-signed-out-1280');
    browsers.delete('cust1');
    await c.close();
  });

  await flow('account: sign out another device from /account/devices', async (r) => {
    const a = await as('cust2');
    const second = await personaBrowser('cust2', { profileKey, outDir: OUT, profileName: 'cust2-second-device' });
    browsers.set('cust2#second', second);
    await a.goto('/account/devices');
    const others = await a.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'خروج از این دستگاه').length`);
    r('ui', 'the devices page lists the other signed-in devices', others >= 1, `${others} other device(s)`);
    await a.shot('account-devices-before-1280');
    await a.click('خروج از همهٔ دستگاه‌های دیگر');
    await a.waitText('خروج از دستگاه‌های دیگر');
    await a.click('خروج از دستگاه‌های دیگر');
    await sleep(2000);
    r('persist', 'DB: only this device keeps an active session', (await activeTokens(ids['user:cust2'])) === 1, await activeTokens(ids['user:cust2']));
    await second.goto('/bookings');
    r('denied', 'the other device is signed out (protected page → sign-in)', (await second.path()) === '/auth', await second.path());
    await a.goto('/account/devices');
    r('persist', 'this device stays signed in; after a reload no other device is listed', (await a.path()) === '/account/devices' && (await a.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'خروج از این دستگاه').length`)) === 0);
    await a.shot('account-devices-after-1280');
    api.delete('cust2'); // its API session was one of the "other devices"
  });
}

// ============================================================================ professional
async function proGroup() {
  const svcName = 'خدمت آزمایشی مرورگر (دمو)';
  await flow('pro: add and remove a service', async (r) => {
    const p = await as('pro2');
    await p.goto('/pro/services');
    await p.fill('نام خدمت', svcName);
    await p.fill('مدت (دقیقه)', '45');
    await p.fill('قیمت (تومان)', '300000');
    await p.click('افزودن خدمت');
    await sleep(1500);
    const row = (await q(`select id, price_toman, duration_minutes from provider.services where professional_id = $1 and name = $2 and deleted_at is null`, [ids.pro2.providerId, svcName]))[0];
    r('persist', 'DB: the service exists with the typed values', row && Number(row.price_toman) === 300000 && Number(row.duration_minutes) === 45, row);
    await p.reload();
    r('persist', 'after a reload the service is listed', await p.has(svcName));
    const c = await as('cust3');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    r('other', 'a customer sees the new service on the public profile', await c.has(svcName));
    const foreign = await (await apiAs('pro1')).call('DELETE', `/v1/providers/${ids.pro2.providerId}/services/${row.id}`, undefined, { expect: [200, 204, 403, 404] });
    r('denied', "another professional cannot delete it", [403, 404].includes(foreign.status), `HTTP ${foreign.status}`);
    const scope = await markRow(p, 'li, tr, article', [svcName]);
    await p.click('حذف', { within: scope });
    const confirmed = await confirmAny(p, ['حذف کن', 'بله، حذف شود', 'حذف خدمت', 'بله، حذف کن']);
    await sleep(1500);
    const gone = (await q(`select deleted_at from provider.services where id = $1`, [row.id]))[0];
    r('persist', 'DB: the service is removed (soft delete)', gone?.deleted_at != null, { confirmed, gone });
    await c.goto(`/providers/${ids.pro2.providerId}`);
    r('other', 'the customer no longer sees it', !(await c.has(svcName)));
  });

  await flow('pro: add and delete a single free time', async (r) => {
    const p = await as('pro2');
    const tomorrow = tehran(Date.now() + 86_400_000).date;
    await p.goto('/pro/availability');
    await p.fill('تاریخ', tomorrow);
    await p.fill('از ساعت', '06:00', { nth: 1 });
    await p.fill('تا ساعت', '06:30', { nth: 1 });
    await p.click('افزودن');
    await sleep(1500);
    const slot = (await q(`select id, status from booking.availability_slots where professional_id = $1 and start_at = ($2::date + time '06:00') at time zone 'Asia/Tehran'`, [ids.pro2.providerId, tomorrow]).catch(async () => q(`select id, status from booking.availability_slots where professional_id = $1 order by created_at desc limit 1`, [ids.pro2.providerId])))[0];
    r('persist', 'DB: the free time exists', Boolean(slot), slot);
    const c = await as('cust3');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    const days = await dayButtons(c);
    await c.click(days[0]);
    r('other', 'a customer sees ۰۶:۰۰ on the first day', (await timeButtons(c)).includes('۰۶:۰۰'), days[0]);
    const foreign = await (await apiAs('pro1')).call('DELETE', `/v1/me/availability/slots/${slot.id}`, undefined, { expect: [200, 204, 403, 404, 409] });
    const still = (await q(`select status from booking.availability_slots where id = $1`, [slot.id]))[0];
    // The delete is scoped by owner in its WHERE clause; a foreign id gets 409 SLOT_NOT_RELEASABLE (misleading
    // wording: 'assigned to an active booking') — still a refusal, and the slot must be untouched.
    r('denied', 'another professional cannot delete it (refused; slot untouched)', foreign.status >= 400 && still?.status === 'open', `HTTP ${foreign.status} ${foreign.raw?.json?.error?.code ?? ''}; slot ${still?.status}`);
    await p.goto('/pro/availability');
    await p.click('حذف', { within: `li[data-slot="${slot.id}"]` });
    await p.click('حذف کن');
    await sleep(1500);
    const after = (await q(`select status from booking.availability_slots where id = $1`, [slot.id]))[0];
    r('persist', 'DB: the free time is gone', !after || after.status !== 'open', after ?? 'row deleted');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    const days2 = await dayButtons(c);
    await c.click(days2[0]);
    r('other', 'the customer no longer sees ۰۶:۰۰', !(await timeButtons(c)).includes('۰۶:۰۰'));
  });

  await flow('pro: mark a past booking done (practitioner)', async (r) => {
    const target = (await q(`select b.id, b.customer_id, b.slot_start from booking.bookings b where b.professional_id = $1 and b.status = 'confirmed' and b.slot_start < now() order by b.slot_start desc limit 1`, [ids.practitioner.providerId]))[0];
    if (!target) throw new Error('no confirmed past booking for the practitioner');
    const custKey = Object.entries(ids).find(([k, v]) => k.startsWith('user:') && v === target.customer_id)?.[0].slice(5);
    const pointsBefore = Number((await q(`select coalesce(sum(points),0) s from loyalty.points_entries where user_id = $1`, [target.customer_id]))[0].s);
    const p = await as('bizPractitioner');
    await p.goto('/pro/bookings');
    await p.click('گذشته', { prefix: true });
    const time = tehran(new Date(target.slot_start).getTime()).time;
    const scope = await markRow(p, 'section[data-day] li', [fa(time)]);
    await p.click('ثبت انجام نوبت', { within: scope });
    await p.click('بله، انجام شد');
    await sleep(2000);
    const b = (await q(`select status, completed_at from booking.bookings where id = $1`, [target.id]))[0];
    r('persist', 'DB: booking completed', b?.status === 'completed' && b.completed_at != null, b);
    await sleep(3000);
    const pointsAfter = Number((await q(`select coalesce(sum(points),0) s from loyalty.points_entries where user_id = $1`, [target.customer_id]))[0].s);
    r('other', 'the customer earned loyalty points for it', pointsAfter > pointsBefore, { pointsBefore, pointsAfter });
    if (custKey) {
      const c = await as(custKey);
      await c.goto('/bookings');
      await c.click('گذشته');
      r('other', "the customer's booking shows as done", await c.evaluate(`document.querySelector('li[data-booking="${target.id}"]')?.innerText.includes('انجام شده') ?? false`));
      await c.goto('/loyalty');
      r('other', "the customer's loyalty page shows the new balance", await c.has(fa(pointsAfter)), fa(pointsAfter));
      const self = await (await apiAs(custKey)).post(`/v1/bookings/${target.id}/complete`, {}, { expect: [200, 201, 400, 403, 404, 409] });
      r('denied', 'the customer cannot mark it done', [403, 404].includes(self.status), `HTTP ${self.status}`);
    }
  });

  await flow('pro: real-time no-show (slot → booking → grace → declaration)', async (r) => {
    // pro1 publishes a time starting in ~4 minutes; cust3 books it with the terms; after the start +
    // the policy's grace, pro1 declares the no-show in the UI. Real time only; nothing backdated.
    const p = await as('pro1');
    const start = Date.now() + 4 * 60_000 + (60_000 - (Date.now() % 60_000));
    const s = tehran(start);
    const e = tehran(start + 30 * 60_000);
    await p.goto('/pro/availability');
    await p.fill('تاریخ', s.date);
    await p.fill('از ساعت', s.time, { nth: 1 });
    await p.fill('تا ساعت', e.time, { nth: 1 });
    await p.click('افزودن');
    await sleep(1500);
    const slot = (await q(`select id, start_at from booking.availability_slots where professional_id = $1 and start_at = $2`, [ids.pro1.providerId, new Date(start).toISOString()]))[0];
    r('persist', 'DB: the near-term free time exists', Boolean(slot), { wanted: s, slot });
    const c = await as('cust3');
    await c.goto(`/providers/${ids.pro1.providerId}`);
    await c.click('میکاپ مجلسی', { prefix: true });
    await c.click((await dayButtons(c))[0]);
    await c.click(fa(s.time));
    await sleep(1500);
    await c.click('این شرایط را خواندم و می‌پذیرم.');
    await c.click('ادامه به پرداخت');
    await c.waitText('پرداخت موفق');
    await c.click('پرداخت موفق');
    await c.waitText('پرداخت انجام شد');
    const bookingId = await bookingOfOrder(orderIdFrom(await c.url()));
    r('ui', 'the customer booked and paid the near-term time', Boolean(bookingId), bookingId);
    await p.goto('/pro/bookings');
    let scope = await markRow(p, 'section[data-day] li', [fa(s.time)]);
    await p.click('عدم حضور مشتری', { within: scope });
    r('ui', 'before the grace ends the panel says it is not yet possible (no button, no timer)', await p.waitText('هنوز ممکن نیست'));
    const grace = Number((await q(`select grace_minutes g from commerce.order_outcome_terms t join commerce.orders o on o.id = t.order_id where o.source_id = $1`, [bookingId]).catch(() => [{ g: 5 }]))[0]?.g ?? 5);
    const waitMs = start + (grace + 1) * 60_000 - Date.now();
    console.log(`waiting ${Math.round(waitMs / 1000)} s for start + ${grace} min grace (real time)`);
    await sleep(Math.max(0, waitMs));
    await declareNoShow(r, bookingId, 'cust3');
  });

  // The declaration alone, for a governed booking already past start + grace (e.g. prepared by the
  // flow above in an earlier run). Real time only: the booking is found, never backdated.
  await flow('pro: declare the no-show in the UI (booking past its grace)', async (r) => {
    const userKey = Object.fromEntries(Object.entries(ids).filter(([k]) => k.startsWith('user:')).map(([k, v]) => [v, k.slice(5)]));
    const b = (await q(`select b.id, b.customer_id from booking.bookings b join commerce.orders o on o.source_id = b.id join commerce.order_outcome_terms t on t.order_id = o.id
      where b.professional_id = $1 and b.status = 'confirmed' and b.slot_start + make_interval(mins => t.grace_minutes) < now() order by b.slot_start desc limit 1`, [ids.pro1.providerId]))[0];
    if (!b) throw new Error('no governed confirmed booking of pro1 past its grace');
    await declareNoShow(r, b.id, userKey[b.customer_id]);
  });
}

/** pro1 declares the no-show in the UI (statement required for a governed booking), then every check. */
async function declareNoShow(r, bookingId, custKey) {
  const p = await as('pro1');
  const slotStart = (await q(`select slot_start from booking.bookings where id = $1`, [bookingId]))[0].slot_start;
  const time = fa(tehran(new Date(slotStart).getTime()).time);
  await p.goto('/pro/bookings');
  let scope = await markRow(p, 'section[data-day] li', [time]);
  await p.click('عدم حضور مشتری', { within: scope });
  await p.click('اعلام عدم حضور', { within: scope });
  await p.waitText('اعلام می‌کنم');
  r('ui', 'the confirmation states what the declaration does and does not do, and asks for a statement', (await p.has('چه نمی‌کند')) && (await p.has('الزامی')));
  await p.fill('توضیح', 'مشتری تا پایان مهلت ارفاق حاضر نشد (آزمون مرورگر دمو).');
  await p.click('اعلام می‌کنم');
  await sleep(2000);
  const b = (await q(`select status from booking.bookings where id = $1`, [bookingId]))[0];
  const decl = await q(`select * from booking.no_show_declarations where booking_id = $1`, [bookingId]);
  r('persist', 'DB: booking is no_show with one declaration', b?.status === 'no_show' && decl.length === 1, { status: b?.status, declarations: decl.length });
  await p.goto('/pro/bookings');
  await p.click('گذشته', { prefix: true });
  scope = await markRow(p, 'section[data-day] li', [time]);
  // The row's own status text, with the buttons' labels removed (a button is not a status).
  const status = scope ? await p.evaluate(`(() => { const li = document.querySelector('[data-flow-row="1"]').cloneNode(true); li.querySelectorAll('button').forEach((x) => x.remove()); return li.innerText; })()`) : '';
  r('persist', 'after a reload the professional sees it recorded (row status, not a button)', /عدم حضور/.test(status), status.replace(/s+/g, ' ').slice(0, 120));
  await p.shot('pro1-no-show-declared-1280');
  if (custKey) {
    const c = await as(custKey);
    await c.goto('/bookings');
    await c.click('گذشته');
    r('other', 'the customer sees the no-show on the booking', await c.evaluate(`document.querySelector('li[data-booking="${bookingId}"]')?.innerText.includes('عدم مراجعه') ?? false`));
    const remedy = await c.evaluate(`[...(document.querySelector('li[data-booking="${bookingId}"]')?.querySelectorAll('button') ?? [])].map((x) => x.innerText.trim())`);
    r('observed', "controls on the customer's no-show card (observation, not a check)", true, remedy);
    await c.shot('customer-no-show-1280');
  }
  const other = await (await apiAs('cust2')).post(`/v1/bookings/${bookingId}/no-show`, {}, { expect: [200, 201, 400, 403, 404, 409, 422] });
  r('denied', 'another customer cannot declare/alter it', [403, 404].includes(other.status), `HTTP ${other.status}`);
}

// ============================================================================ moderation
const reason = 'بررسی شد در آزمون مرورگر دمو (داده ساختگی)';
async function moderationGroup() {
  await flow('moderation: approve a pending verification', async (r) => {
    const m = await as('moderator');
    await m.goto('/admin/verification');
    const scope = await markRow(m, 'li, tr, article', ['سارا کریمی']);
    await m.click('تأیید', { within: scope });
    await m.waitText('تأیید نهایی');
    await m.fill('دلیل تصمیم', reason);
    await m.click('تأیید نهایی');
    await sleep(1500);
    const v = (await q(`select status from provider.verification_requests where professional_id = $1 order by created_at desc limit 1`, [ids.pro2.providerId]))[0];
    r('persist', 'DB: the request is approved', v?.status === 'approved', v);
    await m.reload();
    r('persist', 'after a reload it is no longer in the queue', !(await m.has('سارا کریمی')));
    const c = await as('cust3');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    r('other', 'the public profile now shows the verified badge', await c.has('هویت تأیید شده'));
    const denied = await (await apiAs('cust3')).get('/v1/admin/verification/queue?page=1&limit=5', { expect: [200, 401, 403, 404] });
    r('denied', 'a customer cannot read the verification queue', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });

  await flow('moderation: remove a review', async (r) => {
    const m = await as('moderator');
    await m.goto('/admin/reviews');
    const scope = await markRow(m, 'li, tr, article', ['سارا کریمی']);
    await m.click('بررسی', { within: scope });
    await m.fill('دلیل تصمیم', reason);
    await m.click('حذف');
    await confirmAny(m, ['تأیید و حذف', 'بله، حذف شود', 'حذف کن', 'ثبت نهایی']);
    await sleep(1500);
    const rev = (await q(`select id, status, moderation_reason from provider.reviews where professional_id = $1 order by created_at desc limit 1`, [ids.pro2.providerId]))[0];
    r('persist', 'DB: the review is no longer published, with the typed reason', rev && rev.status !== 'published' && rev.moderation_reason === reason, rev);
    await m.reload();
    r('persist', 'after a reload it left the unreviewed queue', !(await m.has('کاشت ناخن عالی')));
    const pub = await (await apiAs('cust3')).get(`/v1/providers/${ids.pro2.providerId}/reviews`, { expect: [200, 404] });
    r('other', "the public reviews of the professional no longer include it (public API; the web page has no reviews list yet)", !JSON.stringify(pub.data ?? '').includes(rev.id), `HTTP ${pub.status}`);
    const denied = await (await apiAs('cust3')).post(`/v1/admin/reviews/${rev.id}/moderate`, { action: 'publish', reason }, { expect: [200, 201, 400, 401, 403, 404] });
    r('denied', 'a customer cannot moderate reviews', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });

  await flow('moderation: act on an image report (remove the image)', async (r) => {
    const before = (await q(`select id, media_object_id from media.abuse_reports where status = 'open' order by created_at limit 1`))[0];
    if (!before) throw new Error('no open image report');
    const m = await as('moderator');
    await m.goto('/admin/media');
    await m.click('بررسی');
    await m.fill('دلیل تصمیم', reason);
    await m.click('تأیید و حذف');
    await confirmAny(m, ['تأیید و حذف']);
    await sleep(1500);
    const after = (await q(`select status, decided_by from media.abuse_reports where id = $1`, [before.id]))[0];
    r('persist', 'DB: the report is decided by the moderator', after && after.status !== 'open' && after.decided_by === ids['user:moderator'], after);
    const obj = (await q(`select * from media.objects where id = $1`, [before.media_object_id]))[0];
    r('other', 'the reported image is no longer a live object', !obj || Object.entries(obj).some(([k, v]) => /status|deleted|removed/.test(k) && v && v !== 'active' && v !== 'ready'), obj ? Object.fromEntries(Object.entries(obj).filter(([k]) => /status|deleted|removed/.test(k))) : 'row removed');
    const open = Number((await q(`select count(*) n from media.abuse_reports where status = 'open'`))[0].n);
    await m.reload();
    const rows = await m.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'بررسی' && b.getBoundingClientRect().width > 0).length`);
    r('persist', 'after a reload the queue shows exactly the reports still open', rows === open, { open, rows });
  });

  await flow('moderation: reject a chat report', async (r) => {
    const rep = (await q(`select id from chat.reports where status = 'open' order by created_at limit 1`))[0];
    if (!rep) throw new Error('no open chat report');
    const m = await as('moderator');
    await m.goto('/admin/chat-reports');
    await m.click('باز کردن');
    await m.click('رد گزارش', { selector: 'label' });
    await m.fill('دلیل تصمیم', reason);
    await m.click('ثبت تصمیم');
    await confirmAny(m, ['ثبت نهایی']);
    await sleep(1500);
    const after = (await q(`select status, decided_by, decision_reason from chat.reports where id = $1`, [rep.id]))[0];
    r('persist', 'DB: report decided (rejected) with the reason', after && after.status !== 'open' && after.decision_reason === reason, after);
    await m.reload();
    await m.click('ردشده');
    r('persist', 'after a reload it is listed under "ردشده"', await m.has('باز کردن'));
    const denied = await (await apiAs('cust3')).get('/v1/admin/chat/reports', { expect: [200, 401, 403, 404] });
    r('denied', 'a customer cannot read chat reports', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });
}

// ============================================================================ engagement (customer writes)
async function engagementGroup() {
  await flow('chat: customer writes, professional replies', async (r) => {
    const c = await as('cust4');
    const bk = (await q(`select id, professional_id from booking.bookings where customer_id = $1 and status = 'confirmed' order by created_at desc limit 1`, [ids['user:cust4']]))[0];
    await c.goto('/bookings');
    await c.click('پیام', { within: `li[data-booking="${bk.id}"]` });
    await c.waitText('پیام شما');
    const text = `سلام، پرسش آزمایشی مرورگر ${Date.now() % 100000}`;
    await c.fill('پیام شما', text);
    await c.click('ارسال');
    await sleep(1500);
    const msg = (await q(`select conversation_id from chat.messages where body = $1`, [text]))[0];
    r('persist', 'DB: the message is stored', Boolean(msg), msg);
    await c.reload();
    r('persist', 'after a reload the message is in the thread', await c.waitText(text, 8000));
    const proKey = Object.entries(ids).find(([k, v]) => ['pro1', 'pro2', 'practitioner'].includes(k) && v.providerId === bk.professional_id)?.[0];
    const pro = await as(proKey === 'practitioner' ? 'bizPractitioner' : proKey);
    await pro.goto('/pro/messages');
    await pro.click('مشتری', { prefix: true });
    r('other', 'the professional sees the message', await pro.waitText(text, 8000));
    const reply = `پاسخ آزمایشی متخصص ${Date.now() % 100000}`;
    await pro.fill('پیام شما', reply);
    await pro.click('ارسال');
    await sleep(1500);
    await c.reload();
    r('other', 'the customer sees the reply after a reload', await c.waitText(reply, 8000));
    await c.shot('chat-customer-1280');
    const denied = await (await apiAs('cust2')).get(`/v1/chat/conversations/${msg.conversation_id}/messages`, { expect: [200, 403, 404] });
    r('denied', 'another customer cannot read the conversation', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });

  await flow('wishlist: save and remove a professional', async (r) => {
    const c = await as('cust4');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    await c.click('ذخیره در علاقه‌مندی‌ها', { prefix: true });
    await sleep(1200);
    const saved = await q(`select * from wishlist.saved_items where user_id = $1`, [ids['user:cust4']]);
    r('persist', 'DB: the professional is saved', saved.length >= 1, `${saved.length} item(s)`);
    await c.goto('/wishlist');
    r('persist', 'the wishlist lists it after navigation', await c.has('سارا کریمی'));
    await c.click('حذف');
    await sleep(1200);
    await c.reload();
    r('persist', 'after removal and a reload it is gone', !(await c.has('سارا کریمی')));
  });

  await flow('journey: profile, goal, achieved', async (r) => {
    const c = await as('cust4');
    await c.goto('/journey');
    await c.fill('حداکثر بودجه (تومان)', '2500000');
    await c.click('ذخیره');
    r('ui', 'profile saved message', await c.waitText('ذخیره شد.'));
    const goal = `هدف آزمایشی ${Date.now() % 100000}`;
    await c.fill('هدف تازه', goal);
    await c.click('افزودن');
    await sleep(1200);
    await c.reload();
    r('persist', 'after a reload the goal is listed', await c.has(goal));
    const scope = await markRow(c, 'li, article', [goal]);
    await c.click('محقق شد', { within: scope });
    await sleep(1200);
    const g = (await q(`select status from journey.beauty_goals where user_id = $1 and title = $2`, [ids['user:cust4'], goal]))[0];
    const prof = (await q(`select * from journey.beauty_profiles where user_id = $1`, [ids['user:cust4']]))[0];
    r('persist', 'DB: goal achieved and budget stored', g && g.status !== 'active' && JSON.stringify(prof ?? {}).includes('2500000'), { goal: g, budget: prof && Object.fromEntries(Object.entries(prof).filter(([k]) => /budget/.test(k))) });
  });

  await flow('notifications: read one, then all', async (r) => {
    const c = await as('cust4');
    const unread = async () => Number((await q(`select count(*) n from notification.notifications where user_id = $1 and read_at is null`, [ids['user:cust4']]))[0].n);
    const before = await unread();
    await c.goto('/notifications');
    await c.click('خوانده شد');
    await sleep(1200);
    const one = await unread();
    r('persist', 'DB: one fewer unread after "خوانده شد"', one === before - 1, { before, after: one });
    await c.click('علامت‌گذاری همه به‌عنوان خوانده‌شده');
    await sleep(1200);
    await c.reload();
    r('persist', 'DB: none unread after "همه"; persists after a reload', (await unread()) === 0, await unread());
  });

  await flow('assistant: new conversation and a reply', async (r) => {
    const c = await as('cust4');
    const n0 = Number((await q(`select count(*) n from ai.messages m join ai.conversations c on c.id = m.conversation_id where c.user_id = $1`, [ids['user:cust4']]).catch(() => [{ n: -1 }]))[0].n);
    await c.goto('/assistant');
    await c.click('گفتگوی جدید');
    await sleep(1200);
    const fields = await c.evaluate(`[...document.querySelectorAll('textarea, input[type=text]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.labels?.[0]?.innerText || e.placeholder || e.getAttribute('aria-label'))`);
    const consent = await c.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.innerText.trim()).filter((t) => /موافق|می‌پذیرم|پذیرش|ادامه/.test(t))`);
    if (consent.length) await c.click(consent[0]);
    await sleep(800);
    const label = (await c.evaluate(`[...document.querySelectorAll('textarea, input[type=text]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.labels?.[0]?.innerText || e.placeholder || e.getAttribute('aria-label'))`))[0] ?? fields[0];
    await c.fill(label, 'برای مراسم عروسی چه خدمتی پیشنهاد می‌کنی؟');
    const send = await c.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0 && !b.disabled).map((b) => b.innerText.trim()).find((t) => /ارسال|بپرس/.test(t))`);
    await c.click(send);
    await sleep(4000);
    const n1 = Number((await q(`select count(*) n from ai.messages m join ai.conversations c on c.id = m.conversation_id where c.user_id = $1`, [ids['user:cust4']]).catch(() => [{ n: -1 }]))[0].n);
    r('persist', 'DB: the question and the (sandbox) answer are stored', n1 >= n0 + 2, { before: n0, after: n1, consentClicked: consent[0] ?? null });
    await c.shot('assistant-1280');
  });

  await flow('privacy: export request, erasure request and its cancellation', async (r) => {
    const c = await as('cust4');
    const reqs = () => q(`select kind, status from privacy.data_requests where subject_user_id = $1 order by created_at`, [ids['user:cust4']]);
    await c.goto('/account/privacy');
    await c.click('درخواست دریافت داده‌ها');
    await sleep(1500);
    r('persist', 'DB: an export request exists', (await reqs()).some((x) => x.kind === 'export'), await reqs());
    await c.click('شروع حذف حساب');
    await c.waitText('شروع حذف');
    await c.fill('برای تأیید، عبارت', 'DELETE');
    await c.click('شروع حذف');
    await sleep(1500);
    const er = (await q(`select status, execute_after from privacy.data_requests where subject_user_id = $1 and kind <> 'export' order by created_at desc limit 1`, [ids['user:cust4']]))[0];
    r('persist', 'DB: erasure scheduled for later (grace window), not executed', er && !er.completed_at && new Date(er.execute_after) > new Date(), er);
    await c.reload();
    await c.click('لغو درخواست حذف');
    await sleep(1500);
    const er2 = (await q(`select status, cancelled_at from privacy.data_requests where subject_user_id = $1 and kind <> 'export' order by created_at desc limit 1`, [ids['user:cust4']]))[0];
    r('persist', 'DB: erasure cancelled; the account stays usable', er2?.cancelled_at != null && (await c.path()) === '/account/privacy', er2);
    const a = await as('admin');
    await a.goto('/admin/privacy');
    r('other', 'the administrator sees the requests in the privacy queue', await a.has('+۹۸۹۱۲۰۰۰۰۴۰۴') || (await a.has('۰۴۰۴')), 'queue');
  });
}

// ============================================================================ waitlist (end to end)
async function waitlistGroup() {
  // A fresh professional with a single free time makes "no free times" real without deleting seed
  // availability: cust4 registers as a professional in the UI, adds a service and one time.
  const proName = 'متخصص آزمایشی لیست انتظار (دمو)';
  let newPro;
  await flow('waitlist: a customer becomes a professional (UI)', async (r) => {
    const p = await as('cust4');
    await p.goto('/pro/profile');
    await p.fill('نام نمایشی', proName);
    await p.fill('شهر', 'تهران'); // <select>: set by the visible option text below
    await p.click('ناخن', { selector: 'label' });
    await p.click('ساخت پروفایل');
    await sleep(2000);
    newPro = (await q(`select id from provider.professionals where user_id = $1`, [ids['user:cust4']]))[0]?.id;
    r('persist', 'DB: the professional profile exists', Boolean(newPro), newPro);
    await p.goto('/pro/services');
    await p.fill('نام خدمت', 'کاشت آزمایشی');
    await p.fill('مدت (دقیقه)', '30');
    await p.fill('قیمت (تومان)', '200000');
    await p.click('افزودن خدمت');
    await sleep(1200);
    await p.goto('/pro/availability');
    await p.fill('تاریخ', tehran(Date.now() + 2 * 86_400_000).date);
    await p.fill('از ساعت', '11:00', { nth: 1 });
    await p.fill('تا ساعت', '11:30', { nth: 1 });
    await p.click('افزودن');
    await sleep(1200);
    r('persist', 'DB: one service and one open time', Number((await q(`select count(*) n from booking.availability_slots where professional_id = $1 and status = 'open'`, [newPro]))[0].n) === 1);
  });

  const bookIt = async (key) => {
    const c = await as(key);
    await c.goto(`/providers/${newPro}`);
    await c.click((await dayButtons(c))[0]);
    await c.click('۱۱:۰۰');
    await sleep(1200);
    await c.click('ادامه به پرداخت');
    await c.waitText('پرداخت موفق');
    await c.click('پرداخت موفق');
    await c.waitText('پرداخت انجام شد');
    return bookingOfOrder(orderIdFrom(await c.url()));
  };
  const cancelIt = async (key, bookingId) => {
    const c = await as(key);
    await c.goto('/bookings');
    await c.click('لغو رزرو', { within: `li[data-booking="${bookingId}"]` });
    await c.click('بله، لغو کن');
    await sleep(3000);
  };
  const joinIt = async (key) => {
    const w = await as(key);
    await w.goto(`/providers/${newPro}`);
    await w.click('عضویت در لیست انتظار');
    await sleep(1200);
    return w;
  };
  const entry = (key) => q(`select id, status from waitlist.entries where customer_id = $1 and professional_id = $2 order by created_at desc limit 1`, [ids[`user:${key}`], newPro]);

  await flow('waitlist: join, offer on cancellation, decline', async (r) => {
    if (!newPro) throw new Error('needs the new professional');
    const b1 = await bookIt('cust3');
    r('ui', 'cust3 booked the only time', Boolean(b1));
    const w = await joinIt('cust2');
    r('ui', 'with no free time the page offers the waitlist and joining succeeds', await w.has('به لیست انتظار اضافه شدید'));
    r('persist', 'DB: cust2 is waiting', (await entry('cust2'))[0]?.status === 'waiting');
    await cancelIt('cust3', b1);
    await sleep(4000);
    r('other', 'the cancellation offers the reopened time to cust2 (DB)', (await entry('cust2'))[0]?.status === 'offered', (await entry('cust2'))[0]);
    await w.goto('/waitlist');
    r('ui', 'cust2 sees the offer with accept/decline', (await w.has('پذیرفتن و رزرو')) && (await w.has('رد کردن')));
    await w.shot('waitlist-offer-1280');
    await w.click('رد کردن');
    await sleep(1500);
    r('persist', 'DB: declined', (await entry('cust2'))[0]?.status === 'declined');
  });

  await flow('waitlist: second round ends in accept', async (r) => {
    const b2 = await bookIt('cust3');
    const w = await joinIt('cust2');
    r('persist', 'DB: cust2 waiting again (new entry)', (await entry('cust2'))[0]?.status === 'waiting');
    await cancelIt('cust3', b2);
    await sleep(4000);
    await w.goto('/waitlist');
    await w.click('پذیرفتن و رزرو');
    await sleep(2500);
    const e = (await entry('cust2'))[0];
    const bk = (await q(`select id, status from booking.bookings where customer_id = $1 and professional_id = $2 order by created_at desc limit 1`, [ids['user:cust2'], newPro]))[0];
    r('persist', 'DB: entry accepted and a booking for cust2 exists', e?.status === 'accepted' && Boolean(bk), { entry: e, booking: bk });
    r('ui', 'accepting leads to "رزروهای من"', (await w.path()) === '/bookings', await w.path());
    const denied = await (await apiAs('cust3')).post(`/v1/waitlist/${e.id}/accept`, {}, { expect: [200, 201, 400, 403, 404, 409] });
    r('denied', "another customer cannot act on cust2's entry", [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });
}

// ============================================================================ business
async function businessGroup() {
  const staffPhone = ids['user:cust3'] && persona3();
  function persona3() {
    return '09120000403';
  }
  await flow('business: invite staff, accept, grant and revoke finance read', async (r) => {
    const o = await as('bizOwner');
    await o.goto('/business');
    await o.fill('شماره موبایل همکار', staffPhone);
    await o.click('کارمند');
    await o.click('ارسال دعوت');
    await sleep(1500);
    const st = () => q(`select s.id, s.status from business.business_staff s where s.business_id = $1 and s.user_id = $2`, [ids.businessId, ids['user:cust3']]);
    r('persist', 'DB: an invitation for cust3 exists', (await st()).length === 1, await st());
    const c = await as('cust3');
    await c.goto('/business');
    r('other', 'cust3 sees the invitation', await c.has('دعوت‌های شما'));
    await c.click('پذیرفتن');
    await sleep(1500);
    r('persist', 'DB: cust3 is now an active member', (await st())[0]?.status === 'active', await st());
    await c.goto('/finance');
    r('denied', 'as plain staff cust3 has no finance access yet', !(await c.has('سالن')) || (await c.has('دسترسیِ مالی‌ای ندارید')));
    await o.goto('/business');
    const scope = await markRow(o, 'li', ['۰۴۰۳']) ?? (await markRow(o, 'li', ['0403']));
    await o.click('اعطای دسترسیِ فقط‌خواندنیِ مالی', { within: scope });
    await sleep(1500);
    r('persist', 'DB: a finance_read grant exists for cust3', (await q(`select g.* from business.staff_role_grants g join business.business_staff s on s.id = g.staff_id where s.user_id = $1 and s.business_id = $2`, [ids['user:cust3'], ids.businessId])).length >= 1);
    await c.goto('/finance');
    const salon = (await q(`select name from business.businesses where id = $1`, [ids.businessId]))[0]?.name;
    r('other', 'with the grant cust3 sees the salon finance space', await c.has(salon ?? '—'), salon);
    await o.goto('/business');
    const scope2 = await markRow(o, 'li', ['۰۴۰۳']) ?? (await markRow(o, 'li', ['0403']));
    await o.click('بازپس‌گیری', { within: scope2 });
    await o.click('بازپس می‌گیرم');
    await sleep(1500);
    await c.goto('/finance');
    r('denied', 'after revocation cust3 no longer sees the salon finance space', !(await c.has(salon)));
  });
}

// ============================================================================ admin
async function adminGroup() {
  await flow('admin: grant and revoke the moderator role', async (r) => {
    const a = await as('admin');
    const roles = () => q(`select r.key from identity.user_roles ur join identity.roles r on r.id = ur.role_id where ur.user_id = $1`, [ids['user:cust4']]).catch(async () => q(`select * from identity.user_roles where user_id = $1`, [ids['user:cust4']]));
    await a.goto('/admin/users');
    await a.fill('شماره موبایل کاربر', '+989120000404');
    await a.click('جست‌وجو', { selector: 'main button' });
    await a.waitText('ناظر محتوا');
    const scope = await markRow(a, 'li, tr, div', ['ناظر محتوا']);
    await a.click('اعطا', { within: scope });
    await sleep(800);
    const reasonField = await a.evaluate(`[...document.querySelectorAll('textarea, input[type=text]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.labels?.[0]?.innerText || e.placeholder).find((l) => /دلیل/.test(l ?? ''))`);
    if (reasonField) await a.fill(reasonField, reason);
    await confirmAny(a, ['اعطا', 'تأیید', 'ثبت', 'اعطای نقش']);
    await sleep(1500);
    r('persist', 'DB: cust4 has the moderator role', JSON.stringify(await roles()).includes('moderator'), await roles());
    const c = await as('cust4');
    await c.goto('/admin/reviews');
    r('other', 'cust4 can now open the moderation queue', !(await c.has('دسترسی لازم')));
    await a.goto('/admin/users');
    await a.fill('شماره موبایل کاربر', '+989120000404');
    await a.click('جست‌وجو', { selector: 'main button' });
    await a.waitText('ناظر محتوا');
    const scope2 = await markRow(a, 'li, tr, div', ['ناظر محتوا']);
    await a.click('لغو', { within: scope2 });
    await sleep(800);
    const reasonField2 = await a.evaluate(`[...document.querySelectorAll('textarea, input[type=text]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.labels?.[0]?.innerText || e.placeholder).find((l) => /دلیل/.test(l ?? ''))`);
    if (reasonField2) await a.fill(reasonField2, reason);
    await confirmAny(a, ['لغو نقش', 'تأیید', 'ثبت', 'لغو']);
    await sleep(1500);
    r('persist', 'DB: the role is revoked', !JSON.stringify(await roles()).includes('moderator'), await roles());
    await c.goto('/admin/reviews');
    r('denied', 'cust4 is refused again', await c.has('دسترسی لازم'));
    await a.goto('/admin/audit-log');
    r('other', 'the audit log shows the role changes', await a.has('نقش'));
    await a.shot('admin-audit-after-roles-1280');
  });

  await flow('admin: rebuild the search index from the UI', async (r) => {
    const a = await as('admin');
    await a.goto('/admin/search');
    const before = (await q(`select * from search.index_state limit 1`))[0];
    await a.click('بازسازی نمایه');
    await confirmAny(a, ['بازسازی نمایه', 'تأیید', 'بله']);
    await sleep(3000);
    const after = (await q(`select * from search.index_state limit 1`))[0];
    r('persist', 'DB: the index state changed after the rebuild', JSON.stringify(before) !== JSON.stringify(after), { before, after });
    const anon = await personaBrowser('anon-search', { profileKey, outDir: OUT, anonymous: true });
    browsers.set('anon-search', anon);
    await anon.goto('/search');
    await anon.fill('نام متخصص، خدمت یا شهر', 'میکاپ');
    await sleep(2500);
    r('other', 'search still answers after the rebuild (anonymous visitor types a query)', await anon.has('نگار رحیمی'));
    await anon.shot('search-typed-1280');
  });
}

const GROUPS = { checkout: checkoutGroup, account: accountGroup, pro: proGroup, moderation: moderationGroup, engagement: engagementGroup, waitlist: waitlistGroup, business: businessGroup, admin: adminGroup };
for (const g of groups) {
  if (!GROUPS[g]) throw new Error(`unknown group ${g}`);
  await GROUPS[g]();
}
for (const b of browsers.values()) await b.close();
const log = Object.fromEntries([...browsers.entries()].map(([k, b]) => [k, { console: b.log.console, http: b.log.http, throttled: b.log.throttled, dialogs: b.log.dialogs, tls: b.log.docSecurity }]));
fs.writeFileSync(path.join(OUT, 'browser-logs.json'), JSON.stringify(log, null, 2));
console.log(`evidence: ${OUT}`);
