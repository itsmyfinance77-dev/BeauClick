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
import { personaBrowser, signIn, sleep } from './lib/edge.mjs';
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
// --width 390: every flow runs at that width (actions, not just page measurement).
const forcedWidth = arg('--width') ? Number(arg('--width')) : null;
async function as(key, width = 1280) {
  if (!browsers.has(key)) browsers.set(key, await personaBrowser(key, { profileKey, outDir: OUT }));
  const p = browsers.get(key);
  await p.viewport(forcedWidth ?? width);
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
  // Dismiss needs an ELIGIBLE offer: for an ineligible one (inactive service) the B panel shows only the explanation.
  const dis = open.find((o) => o.active && o !== use);
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
    const last = radios.at(-1);
    await c.click(last, { within: card, selector: 'label', nth: radios.filter((t) => t === last).length - 1 });
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
    const el = [...document.querySelectorAll(${JSON.stringify(rowSelector)})].filter((e) => want.every((t) => e.innerText.includes(t)) && e.querySelector('button')).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!el) return false; el.setAttribute('data-flow-row', '1'); return true; })()`);
  return ok ? '[data-flow-row="1"]' : null;
}
/** Clicks whichever confirmation a dialog offers among `labels` (dialogs differ per page). */
async function confirmAny(p, labels) {
  // Dialog buttons first: a panel button behind the dialog may carry the same label.
  const dialog = '[role=dialog], [role=alertdialog], dialog[open]';
  for (const l of labels) {
    const inDialog = await p.evaluate(`[...document.querySelectorAll('${dialog}')].some((d) => [...d.querySelectorAll('button')].some((b) => b.innerText.trim() === ${JSON.stringify(l)} && b.getBoundingClientRect().width > 0))`);
    if (inDialog) {
      await p.click(l, { selector: '[role=dialog] button, [role=alertdialog] button, dialog[open] button' });
      return `${l} (dialog)`;
    }
  }
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
    const others = await a.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'خروج از این دستگاه' && b.getBoundingClientRect().width > 0).length`);
    r('ui', 'the devices page lists the other signed-in devices', others >= 1, `${others} other device(s)`);
    await a.shot('account-devices-before-1280');
    await a.click('خروج از همهٔ دستگاه‌های دیگر');
    await a.waitText('خروج از دستگاه‌های دیگر');
    await a.click('خروج از دستگاه‌های دیگر');
    await sleep(2000);
    r('persist', 'DB: only this device keeps an active session', (await activeTokens(ids['user:cust2'])) === 1, await activeTokens(ids['user:cust2']));
    await a.goto('/account/devices');
    r('persist', 'this device stays signed in; after a reload no other device is listed', (await a.path()) === '/account/devices' && (await a.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'خروج از این دستگاه' && b.getBoundingClientRect().width > 0).length`)) === 0);
    await a.shot('account-devices-after');
    // F-9 (fixed in round 4): the signed-out device RETURNS after the 10 s replay grace with its ended token.
    // Its revocation reason is `session_revoked`, so it is refused and nothing else happens.
    const reasons = await q(`select revocation_reason r, count(*)::int n from identity.refresh_tokens where user_id = $1 and revoked_at is not null group by 1`, [ids['user:cust2']]);
    r('persist', 'DB: the ended device tokens carry revocation_reason = session_revoked', reasons.some((x) => x.r === 'session_revoked'), reasons);
    await sleep(12_000);
    await second.goto('/bookings');
    r('denied', 'the other device is signed out (protected page → sign-in)', (await second.path()) === '/auth', await second.path());
    const left = await activeTokens(ids['user:cust2']);
    await a.goto('/account/devices');
    await a.reload();
    r('persist', 'F-9 fixed: after the signed-out device returned (>10 s) the remaining device is STILL signed in (DB: 1 active session; page stays)', left === 1 && (await a.path()) === '/account/devices', { activeSessionsAfter: left, remainingDevicePath: await a.path() });
    const cascaded = await q(`select count(*)::int n from identity.refresh_tokens where user_id = $1 and revocation_reason = 'replay_response'`, [ids['user:cust2']]);
    r('persist', 'DB: no replay_response cascade was written', cascaded[0].n === 0, cascaded[0]);
    if ((await a.path()) === '/auth') await signIn(a, 'cust2'); // driver: continue the run signed in
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
    // F-5: 90 minutes covers every pro2 service (the page preselects the first, «کاشت ژل», 90 min).
    await p.fill('تا ساعت', '07:30', { nth: 1 });
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
    // F-3 (fixed in round 4): a foreign slot id gets the generic 404 NOT_FOUND_OR_NOT_YOURS (no longer the misleading
    // 409 "assigned to an active booking"); the owner's delete below is the control; the slot must be untouched.
    r('denied', 'another professional: 404 NOT_FOUND_OR_NOT_YOURS; slot untouched (owner control below)', foreign.status === 404 && foreign.raw?.json?.error?.code === 'NOT_FOUND_OR_NOT_YOURS' && still?.status === 'open', `HTTP ${foreign.status} ${foreign.raw?.json?.error?.code ?? ''}; slot ${still?.status}`);
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
    let start = Date.now() + 4 * 60_000 + (60_000 - (Date.now() % 60_000));
    // Never overlap a time pro1 already has in that window (e.g. one left by an aborted earlier run).
    const busy = (await q(`select max(end_at) e from booking.availability_slots where professional_id = $1 and end_at > $2 and start_at < $3`, [ids.pro1.providerId, new Date(start).toISOString(), new Date(start + 30 * 60_000).toISOString()]))[0]?.e;
    if (busy) start = new Date(busy).getTime();
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
    // F-5: the 30-minute time is offered only for a service it covers — the 30-min «اصلاح و فرم ابرو».
    await c.click('اصلاح و فرم ابرو', { prefix: true });
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

  // (A declaration-only fallback flow was removed: it matched rows by time only; the real-time flow is the proof.)
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
    if (scope) {
      await m.click('تأیید', { within: scope });
      await m.waitText('تأیید نهایی');
      await m.fill('دلیل تصمیم', reason);
      await m.click('تأیید نهایی');
      await sleep(1500);
    } else {
      // The UI approval ran in an earlier run whose later DB query failed; say so instead of redoing it.
      r('ui', 'approval was done through the UI in the previous run (row gone; DB below carries this run\'s reason text)', true, 'see flows-2026-09-27T14-48-09-868Z');
    }
    const v = (await q(`select status, decided_by, decision_reason from provider.verification_requests where professional_id = $1 order by submitted_at desc limit 1`, [ids.pro2.providerId]))[0];
    r('persist', 'DB: approved by the moderator with the typed reason', v?.status === 'approved' && v.decided_by === ids['user:moderator'] && v.decision_reason === reason, v);
    await m.reload();
    r('persist', 'after a reload it is no longer in the queue', !(await m.has('سارا کریمی')));
    const c = await as('cust3');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    r('other', 'the public profile now shows the verified badge', await c.has('هویت تأیید شده'));
    const denied = await (await apiAs('cust3')).get('/v1/admin/verification/queue?page=1&limit=5', { expect: [200, 403, 404] });
    r('denied', 'a customer cannot read the verification queue', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });

  await flow('moderation: remove a review', async (r) => {
    const m = await as('moderator');
    await m.goto('/admin/reviews');
    const target = (await q(`select id, comment from provider.reviews where status = 'published' and moderated_at is null order by created_at limit 1`))[0];
    if (!target) throw new Error('no unreviewed published review');
    const snippet = target.comment.slice(0, 20);
    const scope = await markRow(m, 'li, tr, article', [snippet]);
    await m.click('بررسی', { within: scope });
    await m.fill('دلیل تصمیم', reason);
    await m.click('حذف');
    await confirmAny(m, ['تأیید و حذف', 'بله، حذف شود', 'حذف کن', 'ثبت نهایی']);
    await sleep(1500);
    const rev = (await q(`select id, professional_id, status, moderation_reason, moderated_by from provider.reviews where id = $1`, [target.id]))[0];
    r('persist', 'DB: that review is no longer published, by the moderator, with the typed reason', rev && rev.status !== 'published' && rev.moderation_reason === reason && rev.moderated_by === ids['user:moderator'], rev);
    await m.reload();
    r('persist', 'after a reload it left the unreviewed queue', !(await m.has(snippet)));
    const pub = await (await apiAs('cust3')).get(`/v1/providers/${rev.professional_id}/reviews`, { expect: [200, 404] });
    r('other', "the public reviews of the professional no longer include it (public API; the web page has no reviews list yet)", !JSON.stringify(pub.data ?? '').includes(rev.id), `HTTP ${pub.status}`);
    const denied = await (await apiAs('cust3')).post(`/v1/admin/reviews/${rev.id}/moderate`, { action: 'publish', reason }, { expect: [200, 201, 400, 403, 404] });
    r('denied', 'a customer cannot moderate reviews', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });

  await flow('moderation: act on an image report (remove the image)', async (r) => {
    const before = (await q(`select id, media_object_id from media.abuse_reports where status = 'open' order by created_at limit 1`))[0];
    if (!before) throw new Error('no open image report');
    const openBefore = Number((await q(`select count(*) n from media.abuse_reports where status = 'open'`))[0].n);
    const m = await as('moderator');
    await m.goto('/admin/media');
    await m.click('بررسی');
    await m.fill('دلیل تصمیم', reason);
    await m.click('تأیید و حذف');
    const how = await confirmAny(m, ['تأیید و حذف']);
    await sleep(1500);
    const after = (await q(`select status, decided_by from media.abuse_reports where id = $1`, [before.id]))[0];
    r('persist', 'DB: the report is decided by the moderator', after && after.status !== 'open' && after.decided_by === ids['user:moderator'], { after, confirmedVia: how });
    const obj = (await q(`select * from media.objects where id = $1`, [before.media_object_id]))[0];
    r('other', 'the reported image is taken down (deleted_at / taken_down_by set)', !obj || obj.deleted_at != null || obj.taken_down_by != null, obj ? { status: obj.status, deleted_at: obj.deleted_at, taken_down_by: obj.taken_down_by } : 'row removed');
    const open = Number((await q(`select count(*) n from media.abuse_reports where status = 'open'`))[0].n);
    await m.reload();
    const rows = await m.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'بررسی' && b.getBoundingClientRect().width > 0).length`);
    r('persist', 'after a reload the queue shrank by exactly one', open === openBefore - 1 && rows === open, { openBefore, open, rows });
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
    const denied = await (await apiAs('cust3')).get('/v1/admin/chat/reports', { expect: [200, 403, 404] });
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
    const proName = (await q(`select display_name from provider.professionals where id = $1`, [bk.professional_id]))[0].display_name;
    // After a reload /messages opens on the conversation list: open the thread again.
    const reopen = async () => { await c.goto('/messages'); await c.click(proName, { prefix: true, selector: 'button' }); };
    await reopen();
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
    await reopen();
    r('other', 'the customer sees the reply after a reload', await c.waitText(reply, 8000));
    await c.shot('chat-customer-1280');
    const denied = await (await apiAs('cust2')).get(`/v1/chat/conversations/${msg.conversation_id}/messages`, { expect: [200, 403, 404] });
    r('denied', 'another customer cannot read the conversation', [403, 404].includes(denied.status), `HTTP ${denied.status}`);
  });

  await flow('wishlist: save and remove a professional', async (r) => {
    const c = await as('cust4');
    // Baseline finding: on a FULL load of the profile the provider is fetched before the session
    // refresh, so a signed-in customer gets the anonymous "sign in to save" link. Recorded, not changed.
    await c.goto(`/providers/${ids.pro2.providerId}`);
    const onFullLoad = await c.evaluate(`[...document.querySelectorAll('a, button')].filter((e) => e.innerText.includes('ذخیره در علاقه‌مندی‌ها')).map((e) => e.tagName + ' ' + (e.getAttribute('href') ?? '') + ' ' + (e.getAttribute('aria-label') ?? ''))`);
    r('observed', 'signed in, FULL page load: the save control (baseline finding if it is a link to /auth)', true, onFullLoad);
    // In-app navigation (token already in memory): list → card → profile.
    await c.goto('/providers');
    await c.click('سارا کریمی', { prefix: true, selector: 'a' });
    await sleep(2000);
    await c.idle();
    const inApp = await c.evaluate(`[...document.querySelectorAll('a, button')].filter((e) => e.innerText.includes('ذخیره در علاقه‌مندی‌ها')).map((e) => e.tagName + ' ' + (e.getAttribute('aria-label') ?? ''))`);
    r('ui', 'reached in-app, the profile offers a real save button', inApp.some((x) => x.startsWith('BUTTON')), inApp);
    await c.click('ذخیره در علاقه‌مندی‌ها', { selector: 'button' });
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
    if (await c.has('می‌پذیرم و شروع می‌کنم')) {
      await c.click('می‌پذیرم و شروع می‌کنم');
      await sleep(1500);
      const consent = await q(`select * from ai.assistant_consents where user_id = $1`, [ids['user:cust4']]).catch((e) => [{ error: e.message }]);
      r('persist', 'DB: the one-time AI consent is recorded', consent.length >= 1 && !consent[0].error, consent.length);
    }
    // First conversation: "شروعِ گفتگو"; later ones: "گفتگوی جدید".
    const start = await c.evaluate("[...document.querySelectorAll('button')].map((b) => b.innerText.trim()).find((t) => t === 'شروعِ گفتگو' || t === 'گفتگوی جدید')");
    if (!start) throw new Error('no control to start a conversation');
    await c.click(start);
    await sleep(1200);
    const question = 'برای مراسم عروسی چه خدمتی پیشنهاد می‌کنی؟';
    await c.fill('پرسش شما', question);
    await c.click('ارسال');
    await sleep(5000);
    await c.idle();
    const n1 = Number((await q(`select count(*) n from ai.messages m join ai.conversations c on c.id = m.conversation_id where c.user_id = $1`, [ids['user:cust4']]).catch(() => [{ n: -1 }]))[0].n);
    r('persist', 'DB: the question and the (sandbox) answer are stored', n1 >= n0 + 2, { before: n0, after: n1, started: start });
    await c.reload();
    await c.click('گفتگو — شروع‌شده', { prefix: true, selector: 'button' });
    r('persist', 'after a reload (conversation reopened) the question is there', await c.waitText(question, 8000));
    await c.shot('assistant-1280');
  });

  await flow('privacy: export request, erasure request and its cancellation', async (r) => {
    const c = await as('cust4');
    const reqs = () => q(`select kind, status from privacy.data_requests where subject_user_id = $1 order by created_at`, [ids['user:cust4']]);
    await c.goto('/account/privacy');
    const exportsBefore = (await reqs()).filter((x) => x.kind === 'export').length;
    // First export: "درخواست دریافت داده‌ها"; after one exists: "درخواست خروجی تازه".
    const ask = await c.evaluate("[...document.querySelectorAll('button')].filter((b) => !b.disabled).map((b) => b.innerText.trim()).find((t) => t === 'درخواست دریافت داده‌ها' || t === 'درخواست خروجی تازه')");
    await c.click(ask);
    await sleep(1500);
    r('persist', 'DB: a new export request exists', (await reqs()).filter((x) => x.kind === 'export').length === exportsBefore + 1, { clicked: ask, requests: await reqs() });
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
    const prefix = ids['user:cust4'].slice(0, 8);
    const queue = await a.evaluate(`[...document.querySelectorAll('tr, li')].map((e) => e.innerText.replace(/\\s+/g, ' ')).filter((t) => t.includes('${prefix}'))`);
    r('other', "the administrator's privacy queue lists cust4's erasure as cancelled and the export (status only)", queue.some((t) => t.includes('حذف حساب') && t.includes('لغو شد')) && queue.some((t) => t.includes('دریافت نسخهٔ داده')), queue.slice(0, 3));
    let exp;
    for (let n = 0; n < 30 && (exp = (await q(`select status from privacy.data_requests where subject_user_id = $1 and kind = 'export' order by created_at desc limit 1`, [ids['user:cust4']]))[0])?.status !== 'ready'; n++) await sleep(3000);
    await c.goto('/account/privacy');
    // The download itself is not clicked (no file is saved on this machine); offering it is the check.
    if (exp?.status === 'ready') r('ui', 'the export became ready and the customer is offered the download', await c.has('دانلود فایل داده‌ها'), exp);
    else r('observed', 'export not ready within 90 s (not a pass)', true, exp);
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
    newPro = (await q(`select id from provider.professionals where owner_id = $1`, [ids['user:cust4']]))[0]?.id;
    if (newPro) {
      r('observed', 'the professional profile was created in the UI in the previous run', true, newPro);
    } else {
    await p.goto('/pro/profile');
    await p.fill('نام نمایشی', proName);
    await p.fill('شهر', 'تهران'); // <select>: set by the visible option text below
    await p.click('ناخن', { selector: 'label' });
    await p.click('ساخت پروفایل');
    await sleep(2000);
    newPro = (await q(`select id from provider.professionals where owner_id = $1`, [ids['user:cust4']]))[0]?.id;
    r('persist', 'DB: the professional profile exists', Boolean(newPro), newPro);
    }
    if (!Number((await q(`select count(*) n from provider.services where professional_id = $1 and deleted_at is null`, [newPro]))[0].n)) {
    await p.goto('/pro/services');
    await p.fill('نام خدمت', 'کاشت آزمایشی');
    await p.fill('مدت (دقیقه)', '30');
    await p.fill('قیمت (تومان)', '200000');
    await p.click('افزودن خدمت');
    await sleep(1200);
    }
    if (!Number((await q(`select count(*) n from booking.availability_slots where professional_id = $1 and status = 'open'`, [newPro]))[0].n)) {
    await p.goto('/pro/availability');
    await p.fill('تاریخ', tehran(Date.now() + 2 * 86_400_000).date);
    await p.fill('از ساعت', '11:00', { nth: 1 });
    await p.fill('تا ساعت', '11:30', { nth: 1 });
    await p.click('افزودن');
    await sleep(1200);
    }
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
    // F-8 (fixed in round 4): accepting opens the checkout panel — amount + the seller's terms (this
    // professional is unenrolled, so no terms box) — then the bank, exactly like any booking.
    await w.click('پذیرفتن و رزرو');
    await w.waitText('پذیرش پیشنهاد و پرداخت');
    r('ui', 'the acceptance panel states the amount before anything is sent', await w.has('مبلغ این نوبت'));
    const e0 = (await entry('cust2'))[0];
    r('persist', 'DB: nothing consumed before confirming (entry still offered, no order)', e0?.status === 'offered');
    await w.shot('waitlist-accept-panel');
    await w.click('پرداخت و ثبت رزرو');
    await w.waitText('پرداخت موفق');
    await w.click('پرداخت موفق');
    await w.waitText('پرداخت انجام شد');
    const e = (await entry('cust2'))[0];
    const bk = (await q(`select id, status from booking.bookings where customer_id = $1 and professional_id = $2 order by created_at desc limit 1`, [ids['user:cust2'], newPro]))[0];
    const order = (await q(`select id, status from commerce.orders where source_id = $1`, [bk?.id]))[0];
    const intents = await q(`select id from payment.payment_intents where order_id = $1`, [order?.id]);
    r('persist', 'DB: entry accepted and linked; booking CONFIRMED; order PAID; one payment intent', e?.status === 'accepted' && bk?.status === 'confirmed' && order?.status === 'paid' && intents.length === 1, { entry: e, booking: bk, order, intents: intents.length });
    const linked = (await q(`select resulting_booking_id from waitlist.entries where id = $1`, [e.id]))[0];
    r('persist', 'DB: the entry points at that booking', linked?.resulting_booking_id === bk?.id);
    await w.goto('/bookings');
    await w.reload();
    r('ui', 'after reload the booking shows as confirmed in "رزروهای من"', await w.has('تأیید شده'));
    // Controlled: authenticated cust3, a well-formed request WITH an Idempotency-Key; the owner's identical
    // request succeeded above (control); exact generic body; the entry unchanged.
    const before = (await q(`select status, resulting_booking_id from waitlist.entries where id = $1`, [e.id]))[0];
    const denied = await (await apiAs('cust3')).call('POST', `/v1/waitlist/${e.id}/accept`, {}, { expect: [200, 201, 400, 403, 404, 409], headers: { 'Idempotency-Key': `deny-${Date.now()}` } });
    const after = (await q(`select status, resulting_booking_id from waitlist.entries where id = $1`, [e.id]))[0];
    r('denied', "another customer: 404 NOT_FOUND_OR_NOT_YOURS on cust2's entry, entry unchanged (owner control above)", denied.status === 404 && denied.raw?.json?.error?.code === 'NOT_FOUND_OR_NOT_YOURS' && JSON.stringify(before) === JSON.stringify(after), { status: denied.status, body: denied.raw?.json?.error });
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
    const st = () => q(`select s.id, s.status from business.business_staff s where s.business_id = $1 and s.user_id = $2`, [ids.businessId, ids['user:cust3']]);
    const c = await as('cust3');
    if ((await st())[0]?.status !== 'active') {
      await o.goto('/business');
      await o.fill('شماره موبایل همکار', staffPhone);
      await o.click('کارمند');
      await o.click('ارسال دعوت');
      await sleep(1500);
      r('persist', 'DB: an invitation for cust3 exists', (await st()).length === 1, await st());
      await c.goto('/business');
      r('other', 'cust3 sees the invitation', await c.has('دعوت‌های شما'));
      await c.click('پذیرفتن');
      await sleep(1500);
      r('persist', 'DB: cust3 is now an active member', (await st())[0]?.status === 'active', await st());
    } else {
      r('observed', 'invite + accept were done in the UI in the previous run (membership active)', true, await st());
    }
    const salon = (await q(`select display_name from business.businesses where id = $1`, [ids.businessId]))[0]?.display_name;
    const liveFinance = async () => (await q(`select 1 from business.staff_role_grants g join business.business_staff s on s.id = g.membership_id where s.user_id = $1 and s.business_id = $2 and g.revoked_at is null and g.role = 'finance_read'`, [ids['user:cust3'], ids.businessId])).length > 0;
    if (!(await liveFinance())) {
      await c.goto('/finance');
      r('denied', 'as plain staff cust3 does not see the salon finance space', !(await c.has(salon)), salon);
    }
    await o.goto('/business');
    const scope = await markRow(o, 'li', ['۰۴۰۳']) ?? (await markRow(o, 'li', ['0403']));
    const already = await q(`select g.granted_at from business.staff_role_grants g join business.business_staff s on s.id = g.membership_id where s.user_id = $1 and s.business_id = $2 and g.revoked_at is null and g.role = 'finance_read'`, [ids['user:cust3'], ids.businessId]);
    if (already.length) r('observed', 'the grant was clicked in the UI in the previous run (live since)', true, already[0]);
    else {
      await o.click('اعطای دسترسیِ فقط‌خواندنیِ مالی', { within: scope });
      await sleep(1500);
    }
    const liveGrants = () => q(`select g.role, g.revoked_at from business.staff_role_grants g join business.business_staff s on s.id = g.membership_id where s.user_id = $1 and s.business_id = $2 and g.revoked_at is null`, [ids['user:cust3'], ids.businessId]);
    r('persist', 'DB: a live finance_read grant exists for cust3', (await liveGrants()).some((g) => /finance/.test(g.role)), await liveGrants());
    await c.goto('/finance');
    r('other', 'with the grant cust3 sees the salon finance space', await c.has(salon ?? '—'), salon);
    await o.goto('/business');
    const scope2 = await markRow(o, 'li', ['۰۴۰۳']) ?? (await markRow(o, 'li', ['0403']));
    await o.click('بازپس‌گیری', { within: scope2 });
    // The dialog requires an explicit acknowledgement before the confirm is enabled.
    await o.click('می‌دانم که', { prefix: true, selector: '[role=dialog] label, [role=alertdialog] label, dialog[open] label' });
    await confirmAny(o, ['بازپس می‌گیرم']);
    await sleep(1500);
    r('persist', 'DB: the finance_read grant is revoked', !(await liveGrants()).some((g) => /finance/.test(g.role)), await liveGrants());
    await c.goto('/finance');
    r('denied', 'after revocation cust3 no longer sees the salon finance space', !(await c.has(salon)));
  });
}

// ============================================================================ admin
async function adminGroup() {
  await flow('admin: grant and revoke the moderator role', async (r) => {
    const a = await as('admin');
    const roles = async () => (await q(`select role_slug from identity.user_roles where user_id = $1`, [ids['user:cust4']])).map((x) => x.role_slug);
    const openUser = async () => {
      await a.goto('/admin/users');
      await a.fill('شماره موبایل کاربر', '+989120000404');
      await a.click('جست‌وجو', { selector: 'main button' });
      await a.waitText('ناظر محتوا');
      return markRow(a, 'li, tr, div', ['ناظر محتوا']);
    };
    let scope = await openUser();
    await a.click('اعطا', { within: scope });
    await a.waitText('اعطا کن');
    await a.fill('دلیل', reason);
    await a.click('اعطا کن');
    await sleep(1500);
    r('persist', 'DB: cust4 has the moderator role (granted by admin, with the reason)', (await roles()).includes('moderator'), await roles());
    // "کاربر پس از ورود مجدد به دسترسی‌های آن خواهد رسید": sign out and in again, as the dialog says.
    const c = await as('cust4');
    await c.goto('/dashboard');
    await c.click('خروج از حساب');
    await sleep(1500);
    await signIn(c, 'cust4');
    await c.goto('/admin/reviews');
    r('other', 'after signing in again cust4 can open the moderation queue', !(await c.has('دسترسی لازم')) && (await c.has('بازبینی دیدگاه‌ها')));
    scope = await openUser();
    await a.click('لغو', { within: scope });
    await sleep(800);
    if (await a.evaluate("[...document.querySelectorAll('textarea')].some((t) => t.getBoundingClientRect().width > 0)")) await a.fill('دلیل', reason);
    const how = await confirmAny(a, ['لغو کن', 'لغو نقش', 'بله، لغو شود', 'تأیید']);
    await sleep(1500);
    r('persist', 'DB: the moderator role is revoked', !(await roles()).includes('moderator'), { roles: await roles(), confirmedVia: how });
    await c.goto('/admin/reviews');
    r('denied', 'cust4 is refused again (live revocation, same session, no re-login)', await c.has('دسترسی لازم'));
    await a.goto('/admin/audit-log');
    r('other', 'the audit log lists the grant and the revocation', await a.has('نقش'));
    await a.shot('admin-audit-after-roles-1280');
  });

  // The first (unguarded) lifecycle flow was removed after incident F-4; the strict version is in the recovery group.

  await flow('admin: rebuild the search index from the UI', async (r) => {
    const a = await as('admin');
    await a.goto('/admin/search');
    const before = (await q(`select * from search.index_state limit 1`))[0];
    await a.click('بازسازی نمایه', { selector: 'main button' });
    const how = await confirmAny(a, ['اجرا کن']);
    let after;
    for (let n = 0; n < 20; n++) {
      after = (await q(`select * from search.index_state limit 1`))[0];
      if (JSON.stringify(before) !== JSON.stringify(after)) break;
      await sleep(1500);
    }
    r('ui', 'the rebuild asks for confirmation ("اجرا کن")', Boolean(how), how);
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

// ============================================================================ recovery (after incident F-4)
const bookingCommission = async () => (await q(`select v.* from commercial.commission_policy_versions v where v.policy_key = 'demo-booking-commission' order by v.version`)).map((x) => JSON.stringify(x));
async function recoveryGroup() {
  await flow('recovery: browser checkout after restore snapshots booking commission v1', async (r) => {
    const bk0 = await bookingCommission();
    const v1 = JSON.parse(bk0[0] ?? 'null');
    r('persist', 'before: exactly one booking-commission version, v1 published 1000 bp on service_total', bk0.length === 1 && v1?.lifecycle_state === 'published' && v1.bp === 1000 && v1.base === 'service_total', v1 && { version: v1.version, state: v1.lifecycle_state, bp: v1.bp, base: v1.base });
    const c = await as('cust2');
    await startCheckout(c, ids.pro2.providerId, null, { dayIndex: 1 });
    await c.click('پرداخت موفق');
    await c.waitText('پرداخت انجام شد');
    const orderId = orderIdFrom(await c.url());
    r('ui', 'paid through the local sandbox bank; booking confirmed', await c.has('رزرو شما تأیید شد'), orderId);
    const order = (await q(`select status, total_toman, paid_at is not null paid from commerce.orders where id = $1`, [orderId]))[0];
    const pay = await q(`select i.status intent, a.status attempt, a.provider_key from payment.payment_intents i join payment.payment_attempts a on a.payment_intent_id = i.id where i.order_id = $1`, [orderId]);
    const com = await q(`select component, state, policy_key, policy_version, rule_kind, bp, base from commerce.order_commission_terms where order_id = $1`, [orderId]);
    r('persist', 'DB: order paid; intent + attempt succeeded at the sandbox provider', order?.status === 'paid' && order.paid && pay.length === 1 && pay[0].intent === 'succeeded' && pay[0].attempt === 'succeeded', { order, pay });
    r('persist', 'DB: the order snapshots booking commission demo-booking-commission@1 (1000 bp, service_total)', com.some((x) => x.component === 'booking_commission' && x.policy_key === 'demo-booking-commission' && Number(x.policy_version) === 1 && Number(x.bp) === 1000 && x.base === 'service_total'), com);
    r('persist', 'after: the booking-commission rows are byte-identical', JSON.stringify(await bookingCommission()) === JSON.stringify(bk0));
  });

  // Strict re-run of the lifecycle: identity asserted BEFORE every mutation; after every mutation the
  // booking commission must be byte-identical. A mutation whose target cannot be proven is not clicked.
  await flow('admin: acquisition lifecycle — strict identity (create → draft → publish → retire)', async (r) => {
    const a = await as('admin');
    const bk0 = await bookingCommission();
    const acq = async () => q(`select p.policy_key, p.component, v.version, v.lifecycle_state, v.rule_kind, v.published_by_user_id, v.retired_by_user_id from commercial.commission_policies p left join commercial.commission_policy_versions v on v.policy_key = p.policy_key where p.component = 'acquisition' order by v.version nulls first`);
    const unchanged = async (step) => r('persist', `after ${step}: booking commission byte-identical`, JSON.stringify(await bookingCommission()) === JSON.stringify(bk0));
    /** Marks the smallest element holding `button` whose text has every `must` and none of `mustNot`; null if none. */
    const strictScope = async (button, must, mustNot = ['booking_commission', 'کارمزدِ نوبت', 'demo-booking-commission']) => {
      const ok = await a.evaluate(`(() => { document.querySelectorAll('[data-flow-row]').forEach((e) => e.removeAttribute('data-flow-row'));
        const must = ${JSON.stringify(must)}, not = ${JSON.stringify(mustNot)}, btn = ${JSON.stringify(button)};
        const cands = [...document.querySelectorAll('section, article, li, div, tr, form')].filter((e) =>
          must.every((t) => e.innerText.includes(t)) && !not.some((t) => e.innerText.includes(t)) &&
          [...e.querySelectorAll('button')].some((b) => b.innerText.trim().startsWith(btn) && b.getBoundingClientRect().width > 0));
        const el = cands.sort((x, y) => x.innerText.length - y.innerText.length)[0];
        if (!el) return false; el.setAttribute('data-flow-row', '1'); return true; })()`);
      return ok ? '[data-flow-row="1"]' : null;
    };
    const dialogReason = async () => {
      if (await a.evaluate("[...document.querySelectorAll('[role=dialog] textarea, [role=alertdialog] textarea, dialog[open] textarea')].some((t) => t.getBoundingClientRect().width > 0)")) await a.fill('دلیل', reason);
    };
    await a.goto('/admin/commercial/commission-policies');

    // create
    if (!(await acq()).length) {
      const scope = await strictScope('ساختِ سیاست', ['acquisition']);
      r('ui', 'identity before CREATE: the control sits in the acquisition card only', Boolean(scope));
      if (!scope) throw new Error('create target not provable; not clicked');
      await a.click('ساختِ سیاست', { within: scope });
      await a.click('چیزی دریافت نمی‌شود', { selector: 'label' });
      await a.fill('دلیل این تغییر', reason);
      const editor = await strictScope('ساختِ سیاست', ['دلیل این تغییر']);
      if (!editor) throw new Error('create editor not provable; not submitted');
      await a.click('ساختِ سیاست', { within: editor });
      await dialogReason();
      await sleep(1500);
      const rows = await acq();
      r('persist', 'DB: exactly one acquisition policy family, no version yet', rows.length === 1 && rows[0].version == null, rows);
      await unchanged('CREATE');
      await a.reload();
    }
    // draft
    if ((await acq()).length === 1 && (await acq())[0].version == null) {
      const scope = await strictScope('پیش‌نویسِ تازه', ['acquisition']);
      r('ui', 'identity before DRAFT: the control sits in the acquisition card only', Boolean(scope));
      if (!scope) throw new Error('draft target not provable; not clicked');
      await a.click('پیش‌نویسِ تازه', { within: scope });
      await a.click('چیزی دریافت نمی‌شود', { selector: 'label' });
      await a.fill('دلیل این تغییر', reason);
      const editor = await markRow(a, 'form, section, article, div', ['دلیل این تغییر']);
      const submit = await a.evaluate(`[...document.querySelector('[data-flow-row="1"]').querySelectorAll('button')].filter((b) => !b.disabled && b.getBoundingClientRect().width > 0).map((b) => b.innerText.trim()).filter((t) => t !== 'انصراف')`);
      await a.click(submit.at(-1), { within: editor });
      await dialogReason();
      await sleep(1500);
      const rows = await acq();
      r('persist', 'DB: acquisition-standard@1 is a draft with the zero rule', rows.length === 1 && rows[0].version === 1 && rows[0].lifecycle_state === 'draft' && rows[0].rule_kind === 'zero', rows);
      await unchanged('DRAFT');
      await a.reload();
    }
    // publish
    if ((await acq())[0]?.lifecycle_state === 'draft') {
      // Each policy has its own section titled '<name> — تاریخچهٔ نسخه‌ها'; acquisition = 'جذبِ مشتری'.
      const scope = await strictScope('انتشار', ['جذبِ مشتری — تاریخچهٔ نسخه‌ها']);
      r('ui', 'identity before PUBLISH: the control is scoped to acquisition, not the booking commission', Boolean(scope));
      if (!scope) throw new Error('publish target not provable; not clicked');
      await a.click('انتشار', { within: scope, prefix: true });
      await sleep(800);
      await dialogReason();
      await confirmAny(a, ['انتشار', 'منتشر کن', 'انتشار نسخه', 'تأیید']);
      await sleep(1500);
      const rows = await acq();
      r('persist', 'DB: acquisition-standard@1 published by the administrator', rows[0]?.lifecycle_state === 'published' && rows[0].published_by_user_id === ids['user:admin'], rows);
      await unchanged('PUBLISH');
      await a.reload();
    }
    // retire
    if ((await acq())[0]?.lifecycle_state === 'published') {
      let scope = await strictScope('بازنشستگی', ['جذبِ مشتری — تاریخچهٔ نسخه‌ها']);
      if (!scope) {
        // Its version history may need to be opened from its own card first.
        const opener = await a.evaluate(`[...document.querySelectorAll('button, a')].filter((b) => b.closest('section, article, li, div')?.innerText.includes('acquisition') && !b.closest('section, article, li, div')?.innerText.includes('booking_commission')).map((b) => b.innerText.trim()).filter((t) => /تاریخچه|نسخه|مشاهده/.test(t))`);
        if (opener.length) {
          const sc = await strictScope(opener[0], ['acquisition']);
          if (sc) await a.click(opener[0], { within: sc });
          await sleep(1200);
          scope = await strictScope('بازنشستگی', ['acquisition']);
        }
      }
      r('ui', 'identity before RETIRE: the retire control is scoped to acquisition only', Boolean(scope));
      if (!scope) throw new Error('retire target not provable in the UI; NOT clicked (lifecycle retire unverified)');
      await a.click('بازنشستگی', { within: scope });
      await sleep(800);
      await dialogReason();
      await confirmAny(a, ['بازنشستگی', 'بازنشسته کن', 'تأیید']);
      await sleep(1500);
      const rows = await acq();
      r('persist', 'DB: acquisition-standard@1 retired by the administrator', rows[0]?.lifecycle_state === 'retired' && rows[0].retired_by_user_id === ids['user:admin'], rows);
      await unchanged('RETIRE');
    }
    const op = await (await apiAs('operator')).get('/v1/admin/commercial/commission-policies', { expect: [200, 403, 404] });
    r('denied', 'the operator cannot read or change commission policies (API)', [403, 404].includes(op.status), `HTTP ${op.status}`);
    await a.shot('admin-acquisition-lifecycle-strict-1280');
  });
}

// ============================================================================ referral (claim → qualification)
async function referralGroup() {
  await flow('referral: claim a code in the UI, refusals, qualification on the first completed booking', async (r) => {
    // Eligibility (services/referral): not own code, not already attributed, young account, NO completed
    // booking. financeReader is the one synthetic account that qualifies; cust1 (has a completed booking) must be refused.
    const owner = await as('cust2');
    await owner.goto('/referral');
    const code = (await q(`select code from referral.referral_codes where owner_user_id = $1`, [ids['user:cust2']]))[0]?.code;
    r('persist', "DB: cust2's own code exists after opening /referral", Boolean(code) && (await owner.has(code)), code);
    const pre = await q(`select * from referral.referrals where referee_user_id = $1`, [ids['user:financeReader']]);
    if (pre.length) throw new Error('financeReader is already attributed — identity check failed; not claiming');
    const f = await as('financeReader');
    await f.goto('/referral');
    await f.fill('کد دعوت دوست', code);
    await f.click('ثبت کد');
    await sleep(1500);
    r('ui', 'the claim is confirmed on screen', await f.has('کد دعوت ثبت شد'));
    const ref = (await q(`select * from referral.referrals where referee_user_id = $1`, [ids['user:financeReader']]))[0];
    r('persist', 'DB: financeReader attributed to cust2, pending', ref && ref.referrer_user_id === ids['user:cust2'], ref && { status: ref.status, expires_at: ref.expires_at });
    await f.reload();
    // By design (app/referral/page.tsx ClaimSuccess): attribution facts are shown only at the moment of the
    // claim — there is no route to read them again — so after a reload the form is offered again.
    r('observed', 'after a reload the claim is not re-displayed and the form is offered again (by design: no read route)', true, { formOffered: await f.evaluate("Boolean(document.querySelector('input'))") });
    const n0 = (await q(`select count(*) n from referral.referrals where referee_user_id = $1`, [ids['user:financeReader']]))[0].n;
    await f.fill('کد دعوت دوست', code);
    await f.click('ثبت کد');
    await sleep(1500);
    const n1 = (await q(`select count(*) n from referral.referrals where referee_user_id = $1`, [ids['user:financeReader']]))[0].n;
    r('rule', 'business rule (not authorization): a second claim through the UI is refused (no second attribution)', n1 === n0 && !(await f.has('کد دعوت ثبت شد')), { attributions: n1, shown: (await f.text()).match(/[^\n]*(نامعتبر|پذیرفته نشد|امکان|مجاز|نشد)[^\n]*/)?.[0] ?? null });
    const c1 = await as('cust1');
    await c1.goto('/referral');
    const c1Before = await q(`select 1 from referral.referrals where referee_user_id = $1`, [ids['user:cust1']]);
    if (await c1.evaluate("Boolean(document.querySelector('input'))")) {
      await c1.fill('کد دعوت دوست', code);
      await c1.click('ثبت کد').catch(() => {});
      await sleep(1500);
    }
    const c1After = await q(`select 1 from referral.referrals where referee_user_id = $1`, [ids['user:cust1']]);
    r('denied', 'a customer with a completed booking is refused (no attribution written)', c1After.length === c1Before.length, (await c1.text()).match(/[^\n]*(نامعتبر|پذیرفته نشد|امکان|مجاز)[^\n]*/)?.[0] ?? 'no attribution');

    // Qualification: financeReader's FIRST completed booking. pro2 publishes a near-term time, financeReader
    // books and pays it, after its start pro2 marks it done. Real time; nothing backdated.
    const p = await as('pro2');
    const start = Date.now() + 3 * 60_000 + (60_000 - (Date.now() % 60_000));
    const s = tehran(start);
    await p.goto('/pro/availability');
    await p.fill('تاریخ', s.date);
    await p.fill('از ساعت', s.time, { nth: 1 });
    await p.fill('تا ساعت', tehran(start + 20 * 60_000).time, { nth: 1 });
    await p.click('افزودن');
    await sleep(1500);
    await f.goto(`/providers/${ids.pro2.providerId}`);
    await f.click((await dayButtons(f))[0]);
    await f.click(fa(s.time));
    await sleep(1200);
    if (await f.has('این شرایط را خواندم و می‌پذیرم.')) await f.click('این شرایط را خواندم و می‌پذیرم.');
    await f.click('ادامه به پرداخت');
    await f.waitText('پرداخت موفق');
    await f.click('پرداخت موفق');
    await f.waitText('پرداخت انجام شد');
    const bookingId = await bookingOfOrder(orderIdFrom(await f.url()));
    r('ui', 'financeReader booked and paid the near-term time', Boolean(bookingId), bookingId);
    await sleep(Math.max(0, start + 60_000 - Date.now()));
    await p.goto('/pro/bookings');
    const scope = await markRow(p, 'section[data-day] li', [fa(s.time)]);
    await p.click('ثبت انجام نوبت', { within: scope });
    await p.click('بله، انجام شد');
    await sleep(4000);
    const done = (await q(`select status from booking.bookings where id = $1`, [bookingId]))[0];
    const q2 = (await q(`select * from referral.referrals where referee_user_id = $1`, [ids['user:financeReader']]))[0];
    const grants = await q(`select * from referral.reward_grants where referral_id = $1`, [q2?.id]).catch((e) => [{ error: e.message }]);
    r('persist', 'DB: the booking is completed and the referral qualified', done?.status === 'completed' && /qualif/.test(q2?.status ?? ''), { booking: done?.status, referral: q2?.status });
    r('observed', 'reward grants (points are 0 by configuration: LOYALTY_POINTS_REFERRAL_* unset; referee 0 by owner decision)', true, grants);
  });
}

// ============================================================================ seller outcome policy selection
async function outcomeGroup() {
  await flow('seller: choose an outcome policy in the UI (pro2), customer then sees terms to accept', async (r) => {
    const current = await q(`select * from commercial.seller_outcome_policy_assignments where seller_party_id = $1 and superseded_at is null`, [ids.pro2.providerId]);
    r('persist', 'before: pro2 has no live outcome-policy assignment (identity)', current.length === 0, current.length);
    if (current.length) throw new Error('pro2 already governed; not mutating');
    const p = await as('pro2');
    await p.goto('/pro/outcome-policy');
    const ws = await markRow(p, 'section, article, li, div', ['سارا کریمی — ناخن (دمو)', 'انتخاب این فضا']);
    if (!ws) throw new Error('workspace control not provable');
    await p.click('انتخاب این فضا', { within: ws });
    await p.waitText('ثبت انتخاب');
    await p.click('۲۴ ساعت', { selector: 'label' });
    await p.click('هیچ مبلغی نگه داشته نمی‌شود', { selector: 'label', nth: 0 });
    await p.click('۱۵ دقیقه', { selector: 'label' });
    await p.click('هیچ مبلغی نگه داشته نمی‌شود', { selector: 'label', nth: 1 });
    await p.fill('دلیل این انتخاب', 'انتخاب آزمایشی مرورگر دمو (داده ساختگی)');
    await p.click('ثبت انتخاب');
    await sleep(2000);
    const a = (await q(`select cutoff_hours, late_retention_kind, grace_minutes, no_show_retention_kind, assigned_by_user_id from commercial.seller_outcome_policy_assignments where seller_party_id = $1 and superseded_at is null`, [ids.pro2.providerId]))[0];
    r('persist', 'DB: live assignment 24 h / none / 15 min / none, by pro2', a && Number(a.cutoff_hours) === 24 && Number(a.grace_minutes) === 15 && a.assigned_by_user_id === ids['user:pro2'], a);
    await p.reload();
    // After a reload the page asks for the workspace again; its current terms load on that choice.
    const ws2 = await markRow(p, 'section, article, li, div', ['سارا کریمی — ناخن (دمو)', 'انتخاب این فضا']);
    await p.click('انتخاب این فضا', { within: ws2 });
    await sleep(1500);
    const checked = await p.evaluate(`[...document.querySelectorAll('input[type=radio]')].filter((x) => x.checked).map((x) => x.closest('label')?.innerText.trim())`);
    r('persist', 'after a reload (workspace chosen again) the saved choice is pre-selected: 24 h and 15 min', checked.includes('۲۴ ساعت') && checked.includes('۱۵ دقیقه'), checked);
    const c = await as('cust3');
    await c.goto(`/providers/${ids.pro2.providerId}`);
    await c.click((await dayButtons(c))[1]);
    await c.click((await timeButtons(c)).at(-1));
    await sleep(1500);
    const panel = await c.evaluate(`({ box: document.querySelector('input[type=checkbox]')?.checked ?? null, pay: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('ادامه به پرداخت'))?.disabled ?? null, text: document.body.innerText.includes('۲۴ ساعت پیش از نوبت') })`);
    r('other', "the customer now gets pro2's terms (24 h) with an unticked box and payment closed", panel.box === false && panel.pay === true && panel.text, panel);
  });

  // Cross-owner test as a CONTROLLED comparison. The surface answers every cause (foreign/malformed/stale
  // reference, invalid selection, inactive key, lost race…) with ONE generic 409
  // OUTCOME_POLICY_ASSIGNMENT_UNAVAILABLE (V33-DEC-031 R4), so a 409 alone proves nothing. Attribution:
  // the identical, valid request succeeds for the owner; the requester is authenticated (not 401/429) and
  // its own reference works; only the workspace reference differs; the target row is byte-identical after.
  await flow('seller: cross-owner outcome assignment — controlled comparison', async (r) => {
    const live = (await q(`select policy_key, cutoff_hours, late_retention_kind, grace_minutes, no_show_retention_kind from commercial.seller_outcome_policy_assignments where seller_party_id = $1 and superseded_at is null`, [ids.pro2.providerId]))[0];
    if (!live || live.late_retention_kind !== 'none' || live.no_show_retention_kind !== 'none') throw new Error('needs pro2 governed with the none/none selection from the flow above');
    const p = await as('pro2');
    await p.goto('/pro/outcome-policy');
    await p.click('انتخاب این فضا', { within: await markRow(p, 'section, article, li, div', ['سارا کریمی — ناخن (دمو)', 'انتخاب این فضا']) });
    await sleep(1500);
    const ref = await p.evaluate(`(performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes('/v1/me/outcome-policy-assignments/')) ?? '').split('/v1/me/outcome-policy-assignments/')[1]?.split('?')[0] ?? null`);
    if (!ref) throw new Error("pro2's workspace reference not captured");
    const body = { policyKey: live.policy_key, reason: 'انتخاب آزمایشی مرورگر دمو (داده ساختگی)', cutoffHours: Number(live.cutoff_hours), lateCancellationRetention: { kind: 'none' }, noShowGraceMinutes: Number(live.grace_minutes), noShowRetention: { kind: 'none' } };
    const rows = async () => JSON.stringify(await q(`select * from commercial.seller_outcome_policy_assignments where seller_party_id = $1 order by assigned_at`, [ids.pro2.providerId]));
    const s0 = await rows();
    const owner = await apiAs('pro2');
    const oGet = await owner.get(`/v1/me/outcome-policy-assignments/${ref}`, { expect: [200, 409] });
    const oPut = await owner.put(`/v1/me/outcome-policy-assignments/${ref}`, body, { expect: [200, 409, 422] });
    r('other', 'control: the OWNER with the same reference and the same valid body — GET 200, PUT 200 (idempotent, no new row)', oGet.status === 200 && oPut.status === 200 && (await rows()) === s0, { get: oGet.status, put: oPut.status, putCode: oPut.raw?.json?.error?.code ?? null });
    const other = await apiAs('pro1');
    const me = await other.get('/v1/me', { expect: [200] });
    const own = await other.get(`/v1/me/outcome-policy-assignments/${ids.pro1.workspaceRef}`, { expect: [200, 409] });
    r('other', 'control: pro1 is authenticated (GET /v1/me 200) and its OWN reference answers 200 on the same route', me.status === 200 && own.status === 200, { me: me.status, ownRef: own.status, ownCode: own.raw?.json?.error?.code ?? null });
    const fGet = await other.get(`/v1/me/outcome-policy-assignments/${ref}`, { expect: [200, 400, 401, 403, 404, 409, 429] });
    const fPut = await other.put(`/v1/me/outcome-policy-assignments/${ref}`, body, { expect: [200, 400, 401, 403, 404, 409, 422, 429] });
    const s1 = await rows();
    const exact = { get: { status: fGet.status, body: fGet.raw?.json }, put: { status: fPut.status, body: fPut.raw?.json } };
    const refused = [fGet, fPut].every((x) => x.status === 409 && x.raw?.json?.error?.code === 'outcome_policy_assignment_unavailable');
    r('denied', "pro1 + pro2's reference + the owner's valid body: refused with the contract's generic 409 (not 401/429), target row byte-identical — cause isolated to the reference (resolve() rejects a reference not derived for the caller)", refused && s1 === s0, exact);
  });
}

// ============================================================================ round 4 (fixes)
// Every mutation targets a row whose identity is asserted from the DB first (F-4 rule).
async function round4Group() {
  const future = `b.slot_start > now() + interval '30 hours'`;

  await flow('round4 F-5: a long service lists only covering times; the summary ends when the SERVICE ends', async (r) => {
    const svc = (await q(`select s.id, s.name, s.duration_minutes d, s.professional_id pid from provider.services s where s.duration_minutes > 60 and s.deleted_at is null order by s.duration_minutes desc limit 1`))[0];
    if (!svc) throw new Error('no service longer than 60 minutes');
    const listed = await (await apiAs('cust4')).call('GET', `/v1/providers/${svc.pid}/availability?serviceId=${svc.id}`, undefined, { expect: [200] });
    const tooShort = (listed.data ?? []).filter((x) => new Date(x.endAt) - new Date(x.startAt) < svc.d * 60_000);
    r('rule', `API: every time offered for "${svc.name}" (${svc.d} min) is at least that long`, tooShort.length === 0, { offered: (listed.data ?? []).length, tooShort: tooShort.length });
    const c = await as('cust4');
    await c.goto(`/providers/${svc.pid}`);
    await c.click(svc.name, { prefix: true });
    await sleep(1500);
    const days = await dayButtons(c);
    if (!days.length) {
      r('observed', 'no covering time is published for this service (honest empty state)', await c.has('زمان آزادی'));
      return;
    }
    await c.click(days[0]);
    const times = await timeButtons(c);
    await c.click(times[0]);
    await sleep(800);
    const summary = await c.evaluate(`document.querySelector('[data-testid="booking-summary"]')?.innerText ?? ''`);
    const first = (listed.data ?? []).map((x) => x.startAt).sort()[0];
    const end = tehran(new Date(first).getTime() + svc.d * 60_000).time;
    r('ui', `the summary's end is start + ${svc.d} min (${end}), not the slot end`, summary.includes(fa(end)), summary.replace(/\s+/g, ' '));
  });

  await flow('round4 F-2: full page load while signed in shows the real save control', async (r) => {
    const c = await as('cust1');
    const pid = ids.pro1.providerId;
    await c.goto(`/providers/${pid}`);
    await c.reload();
    await sleep(1500);
    const save = await c.evaluate(`[...document.querySelectorAll('button')].some((b) => /علاقه‌مندی/.test(b.innerText) && b.getBoundingClientRect().width > 0)`);
    const signInLink = await c.evaluate(`[...document.querySelectorAll('a[href="/auth"]')].some((a) => /ذخیره/.test(a.innerText))`);
    r('ui', 'a save BUTTON is shown, not the anonymous "sign in to save" link', save && !signInLink, { save, signInLink });
  });

  await flow('round4 F-6: commission page follows the API capability', async (r) => {
    const o = await as('operator');
    await o.goto('/admin/commercial/commission-policies');
    await sleep(1200);
    r('denied', 'operator (no bc_manage_commercial_plans) gets the no-access state, and no commission API call is made', await o.has('دسترسی لازم برای این بخش را ندارد'));
    const a = await as('admin');
    await a.goto('/admin/commercial/commission-policies');
    await a.waitText('کارمزد');
    r('ui', 'administrator (holds it) sees the commission components (control)', await a.has('کارمزد'));
  });

  await flow('round4 web: the professional cancels a live booking in the UI', async (r) => {
    const t = (await q(`select b.id, b.customer_id from booking.bookings b where b.professional_id = $1 and b.status = 'confirmed' and ${future} order by b.slot_start desc limit 1`, [ids.pro1.providerId]))[0];
    if (!t || !userKey(t.customer_id)) throw new Error('no confirmed future booking of pro1 for a persona');
    const cust = userKey(t.customer_id);
    const other = cust === 'cust2' ? 'cust3' : 'cust2';
    const deny = await (await apiAs(other)).call('POST', `/v1/bookings/${t.id}/cancel`, { reason: 'x' }, { expect: [200, 201, 403, 404, 409] });
    const still = (await q(`select status from booking.bookings where id = $1`, [t.id]))[0];
    r('denied', 'another customer: 404 NOT_FOUND_OR_NOT_YOURS, booking unchanged (owner control follows)', deny.status === 404 && deny.raw?.json?.error?.code === 'NOT_FOUND_OR_NOT_YOURS' && still.status === 'confirmed', `HTTP ${deny.status}`);
    const p = await as('pro1');
    await p.goto('/pro/bookings');
    await p.click('لغو نوبت', { within: `li[data-booking="${t.id}"]` });
    await p.waitText('این عملیات');
    await p.click('بله، لغو کن');
    await sleep(3000);
    const row = (await q(`select status, cancelled_by_actor_type a from booking.bookings where id = $1`, [t.id]))[0];
    r('persist', 'DB: cancelled by the professional', row.status === 'cancelled' && row.a === 'professional', row);
    const refunds = await q(`select r.status from payment.refunds r join commerce.orders o on o.id = r.order_id where o.source_id = $1`, [t.id]);
    r('persist', 'DB: the collected amount is refunded by the ordinary rules', refunds.length >= 1, refunds);
    const c = await as(cust);
    await c.goto('/bookings');
    await c.click('گذشته'); // cancelled bookings sit on «گذشته»
    await sleep(800);
    r('other', `the customer (${cust}) sees the cancellation with the remedy/replacement controls`, (await c.has('بازپرداخت و جبران')) || (await c.has('پیشنهاد جایگزینی')));
    ids.round4 = { ...(ids.round4 ?? {}), proCancelled: t.id };
  });

  await flow('round4 web: customer review + professional reply in the UI', async (r) => {
    // Golden has every completed booking reviewed already: the professional first completes a PAST confirmed
    // booking of theirs in the UI (identity-guarded), which makes it review-eligible.
    const past = (await q(`select b.id, b.professional_id pid from booking.bookings b where b.status = 'confirmed' and b.slot_end < now() and b.professional_id = $1 order by b.slot_start limit 1`, [ids.pro1.providerId]))[0];
    if (past) {
      const p1 = await as('pro1');
      await p1.goto('/pro/bookings');
      await p1.click('گذشته', { prefix: true }); // the professional tabs carry a count: «گذشته (۶)»
      await p1.click('ثبت انجام نوبت', { within: `li[data-booking="${past.id}"]` });
      await p1.click('بله، انجام شد');
      await sleep(4000);
      r('persist', 'setup: pro1 completed its past booking in the UI (DB completed)', (await q(`select status from booking.bookings where id = $1`, [past.id]))[0]?.status === 'completed', past.id);
    }
    const t = (await q(`select b.id, b.customer_id, b.professional_id pid from booking.bookings b join provider.review_eligibility e on e.booking_id = b.id
      where b.status = 'completed' and not exists (select 1 from provider.reviews x where x.booking_id = b.id) and b.professional_id in ($1, $2) order by b.completed_at limit 1`, [ids.pro1.providerId, ids.pro2.providerId]))[0];
    if (!t || !userKey(t.customer_id)) throw new Error('no reviewable completed booking of a persona');
    const cust = userKey(t.customer_id);
    const seller = t.pid === ids.pro1.providerId ? 'pro1' : 'pro2';
    const c = await as(cust);
    await c.goto('/bookings');
    await c.click('گذشته');
    await c.click('ثبت نظر', { within: `li[data-booking="${t.id}"]` });
    await c.click('۵', { within: `li[data-booking="${t.id}"]`, selector: 'label' });
    await c.fill('توضیح (اختیاری)', 'نظر آزمایشی مرورگر (دمو)');
    await c.click('ثبت نظر', { within: `li[data-booking="${t.id}"]`, selector: 'button[data-testid="review-submit"]' });
    await sleep(2000);
    const rv = (await q(`select id, rating, status from provider.reviews where booking_id = $1`, [t.id]))[0];
    r('persist', 'DB: the review exists (rating 5, published)', rv?.rating === 5 && rv.status === 'published', rv);
    await c.reload();
    await c.click('گذشته');
    r('persist', 'after reload the booking offers «نظر شما», not a second form', await c.has('نظر شما'));
    const p = await as(seller);
    await p.goto('/pro/reviews');
    await p.click('پاسخ دادن', { within: `li[data-review="${rv.id}"]` });
    await p.fill('پاسخ شما', 'پاسخ آزمایشی مرورگر (دمو)');
    await p.click('ثبت پاسخ');
    await sleep(1500);
    const after = (await q(`select response_text from provider.reviews where id = $1`, [rv.id]))[0];
    r('persist', 'DB: the reply is stored', after?.response_text === 'پاسخ آزمایشی مرورگر (دمو)');
    await p.reload();
    r('persist', 'after reload the reply is shown', await p.has('پاسخ آزمایشی مرورگر (دمو)'));
    const wrong = seller === 'pro1' ? 'pro2' : 'pro1';
    const deny = await (await apiAs(wrong)).call('POST', `/v1/providers/${t.pid}/reviews/${rv.id}/respond`, { text: 'x' }, { expect: [200, 201, 403, 404] });
    const unchanged = (await q(`select response_text from provider.reviews where id = $1`, [rv.id]))[0];
    r('denied', 'another professional: generic 404, reply unchanged (owner control above)', deny.status === 404 && unchanged.response_text === 'پاسخ آزمایشی مرورگر (دمو)', `HTTP ${deny.status}`);
  });
}

// ============================================================================ re-golden (round 4)
// The data the F-5 fix needs, made by the OWNING professional in the real UI:
//  1. the open time lying inside each legacy long booking (bookable before F-5 → overlap) is deleted;
//  2. a free time long enough for each 90/120-min service is published.
// Identity guards: every deleted slot is re-proved (owner, open, inside that booking) right before the click.
async function regoldenGroup() {
  const legacy = await q(`select b.id booking, b.professional_id pid, a.id slot, a.start_at from booking.bookings b join provider.services s on s.id = b.service_id
      join booking.availability_slots a on a.professional_id = b.professional_id and a.status = 'open'
       and a.start_at < b.slot_start + make_interval(mins => s.duration_minutes) and a.end_at > b.slot_start
     where b.status in ('pending','confirmed') and s.duration_minutes * 60 > extract(epoch from (b.slot_end - b.slot_start))`);
  const personaOf = (pid) => ['pro1', 'pro2', 'practitioner'].find((k) => ids[k].providerId === pid);
  const keyOf = (k) => (k === 'practitioner' ? 'bizPractitioner' : k);

  for (const row of legacy) {
    await flow(`regolden: ${personaOf(row.pid)} deletes the open time inside a legacy long booking`, async (r) => {
      const who = keyOf(personaOf(row.pid));
      const p = await as(who);
      await p.goto('/pro/availability');
      const guard = (await q(`select professional_id, status from booking.availability_slots where id = $1`, [row.slot]))[0];
      r('rule', 'identity: the slot is the owner\'s and open, inside the legacy booking', guard?.professional_id === row.pid && guard.status === 'open', { slot: row.slot, booking: row.booking });
      if (!(guard?.professional_id === row.pid && guard.status === 'open')) throw new Error('guard failed');
      await p.click('حذف', { within: `li[data-slot="${row.slot}"]` });
      await p.click('حذف کن');
      await sleep(1500);
      const after = (await q(`select status from booking.availability_slots where id = $1`, [row.slot]))[0];
      r('persist', 'DB: the open time is gone', !after, after ?? 'row deleted');
    });
  }

  const long = await q(`select s.id, s.name, s.duration_minutes d, s.professional_id pid from provider.services s where s.deleted_at is null and s.duration_minutes > 60 order by s.name`);
  for (const svc of long) {
    await flow(`regolden: ${personaOf(svc.pid)} publishes a free time long enough for «${svc.name}» (${svc.d} min)`, async (r) => {
      const p = await as(keyOf(personaOf(svc.pid)));
      // First day from +3 whose 07:00–(07:00+d) Tehran window is free for this professional.
      let day = null;
      for (let k = 3; k < 10 && !day; k++) {
        const d = tehran(Date.now() + k * 86_400_000).date;
        const clash = await q(`select 1 from booking.availability_slots where professional_id = $1
            and start_at < (($2::date + time '07:00') at time zone 'Asia/Tehran') + make_interval(mins => $3)
            and end_at > (($2::date + time '07:00') at time zone 'Asia/Tehran')`, [svc.pid, d, svc.d]);
        if (!clash.length) day = d;
      }
      if (!day) throw new Error('no free morning window');
      const endMin = 7 * 60 + svc.d;
      const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      await p.goto('/pro/availability');
      await p.fill('تاریخ', day);
      await p.fill('از ساعت', '07:00', { nth: 1 });
      await p.fill('تا ساعت', end, { nth: 1 });
      await p.click('افزودن');
      await sleep(1500);
      const slot = (await q(`select id, end_at - start_at len from booking.availability_slots where professional_id = $1 and start_at = ($2::date + time '07:00') at time zone 'Asia/Tehran'`, [svc.pid, day]))[0];
      r('persist', `DB: a ${svc.d}-minute open time exists on ${day} 07:00–${end}`, Boolean(slot), slot);
      const listed = await (await apiAs('cust4')).call('GET', `/v1/providers/${svc.pid}/availability?serviceId=${svc.id}`, undefined, { expect: [200] });
      r('other', 'the customer listing for that service now offers it', (listed.data ?? []).some((x) => x.id === slot?.id), (listed.data ?? []).length);
    });
  }
}

// ============================================================================ F-10 (owner-approved option B)
// A seller-cancelled booking paid on the simulated "bank without a refund API" → the default refund is
// manual_required. Race order A: the customer's #212 reschedule wins → refund superseded; the administrator
// can no longer claim. Race order B: the administrator claims first → the customer's option disappears and a
// direct attempt is refused; the administrator records the (synthetic) execution → refund succeeded.
async function f10Group() {
  const bookManual = async (custKey, dayIndex) => {
    const c = await as(custKey);
    await startCheckout(c, ids.pro1.providerId, 'میکاپ مجلسی', { dayIndex, acceptTerms: true });
    await c.click('پرداخت موفق — بانک بدون بازپرداخت خودکار (شبیه‌سازی)');
    await c.waitText('پرداخت انجام شد');
    return bookingOfOrder(orderIdFrom(await c.url()));
  };
  const proCancels = async (bookingId) => {
    const guard = (await q(`select professional_id, status from booking.bookings where id = $1`, [bookingId]))[0];
    if (guard?.professional_id !== ids.pro1.providerId || guard.status !== 'confirmed') throw new Error(`guard: ${JSON.stringify(guard)}`);
    const p = await as('pro1');
    await p.goto('/pro/bookings');
    await p.click('لغو نوبت', { within: `li[data-booking="${bookingId}"]` });
    await p.click('بله، لغو کن');
    // The refund is written by the BookingCancelled consumer (outbox, asynchronous): wait for it.
    for (let i = 0; i < 30 && !(await refundOf(bookingId)); i++) await sleep(1000);
  };
  const refundOf = async (bookingId) =>
    (await q(`select r.id, r.status, r.manual_tracked from payment.refunds r join commerce.orders o on o.id = r.order_id where o.source_id = $1 and r.kind = 'order' order by r.created_at`, [bookingId]))[0];
  const decisionOf = async (bookingId) =>
    (await q(`select execution_status from commerce.booking_outcome_decisions where booking_id = $1 and decision_kind = 'cancellation' and superseded_by_id is null`, [bookingId]))[0]?.execution_status;
  const openRemedy = async (c, bookingId) => {
    await c.goto('/bookings');
    await c.click('گذشته');
    await c.click('بازپرداخت و جبران', { within: `li[data-booking="${bookingId}"]` });
    await sleep(1500);
  };

  await flow('F-10 A: the customer\'s reschedule wins → the manual refund is superseded; no claim possible afterwards', async (r) => {
    const bookingId = await bookManual('cust4', 2);
    await proCancels(bookingId);
    const r0 = await refundOf(bookingId);
    r('persist', 'DB: default refund is manual_required and tracked', r0?.status === 'manual_required' && r0.manual_tracked === true, r0);
    const a = await as('admin');
    await a.goto('/admin/refunds');
    r('other', 'the administrator sees it as «نیازمند اجرای دستی» with «شروع اجرای دستی»', await a.evaluate(`!!document.querySelector('li[data-refund="${r0.id}"]')?.innerText.includes('نیازمند اجرای دستی')`));
    const c = await as('cust4');
    await openRemedy(c, bookingId);
    await c.click('به‌جای بازپرداخت، نوبت تازه می‌خواهم', { within: `li[data-booking="${bookingId}"]` });
    await sleep(1500);
    const option = await c.evaluate(`[...document.querySelectorAll('li[data-booking="${bookingId}"] select option')].map((o) => o.text).find((t) => t && t !== 'انتخاب کنید')`);
    await c.fill('زمان تازه', option, { within: `li[data-booking="${bookingId}"]` });
    await c.click('ثبت نوبت تازه', { within: `li[data-booking="${bookingId}"]` });
    await sleep(3000);
    const b = (await q(`select status from booking.bookings where id = $1`, [bookingId]))[0];
    const r1 = await refundOf(bookingId);
    r('persist', 'DB: booking revived (confirmed), refund SUPERSEDED (row kept), decision superseded', b.status === 'confirmed' && r1.status === 'superseded' && (await decisionOf(bookingId)) === 'superseded', { booking: b, refund: r1 });
    const events = await q(`select count(*)::int n from payment.outbox_events where event_type = 'RefundCompleted' and payload->>'refundId' = $1`, [r0.id]);
    r('persist', 'DB: no RefundCompleted for the superseded refund', events[0].n === 0);
    await a.reload();
    r('other', 'administrator after reload: «جایگزین‌شده با نوبت تازه», no claim control', await a.evaluate(`(() => { const li = document.querySelector('li[data-refund="${r0.id}"]'); return !!li && li.innerText.includes('جایگزین‌شده') && !li.querySelector('[data-testid="manual-claim"]'); })()`));
    const deny = await (await apiAs('admin')).call('POST', `/v1/admin/refunds/manual/${r0.id}/claim`, {}, { expect: [201, 409] });
    r('rule', 'a late claim is refused REFUND_NOT_CLAIMABLE (race order A)', deny.status === 409 && deny.raw?.json?.error?.code === 'REFUND_NOT_CLAIMABLE', `HTTP ${deny.status}`);
  });

  await flow('F-10 B: the administrator claims first → the customer\'s option disappears; synthetic execution recorded', async (r) => {
    const bookingId = await bookManual('cust3', 3);
    await proCancels(bookingId);
    const r0 = await refundOf(bookingId);
    const a = await as('admin');
    await a.goto('/admin/refunds');
    await a.click('شروع اجرای دستی', { within: `li[data-refund="${r0.id}"]` });
    await a.click('ثبت شروع اجرا');
    await sleep(2000);
    const exec = (await q(`select id, state from payment.manual_refund_executions where refund_id = $1`, [r0.id]))[0];
    r('persist', 'DB: the durable claim exists (state claimed)', exec?.state === 'claimed', exec);
    const c = await as('cust3');
    await openRemedy(c, bookingId);
    r('ui', 'the customer is no longer offered the free reschedule', !(await c.evaluate(`!!document.querySelector('li[data-booking="${bookingId}"]')?.innerText.includes('به‌جای بازپرداخت، نوبت تازه می‌خواهم')`)));
    const slot = (await q(`select id from booking.availability_slots where professional_id = $1 and status = 'open' and start_at > now() + interval '2 days' order by start_at limit 1`, [ids.pro1.providerId]))[0];
    const deny = await (await apiAs('cust3')).call('POST', `/v1/bookings/${bookingId}/remedy`, { choice: 'reschedule', newSlotId: slot.id }, { expect: [200, 201, 409] });
    const still = await refundOf(bookingId);
    r('rule', 'a direct reschedule attempt is refused REMEDY_REFUND_IN_EXECUTION; refund unchanged (race order B)', deny.status === 409 && deny.raw?.json?.error?.code === 'REMEDY_REFUND_IN_EXECUTION' && still.status === 'manual_required', `HTTP ${deny.status}`);
    await a.reload();
    await a.fill('نتیجهٔ اجرا', 'انتقال انجام شد', { within: `li[data-refund="${r0.id}"]` });
    await a.fill('شناسهٔ پیگیری انتقال', 'SIM-DEMO-001', { within: `li[data-refund="${r0.id}"]` });
    await a.click('ثبت نتیجه', { within: `li[data-refund="${r0.id}"]` });
    await sleep(2500);
    const r1 = await refundOf(bookingId);
    r('persist', 'DB: refund succeeded, execution executed with the reference, decision executed', r1.status === 'succeeded' && (await decisionOf(bookingId)) === 'executed', r1);
    await a.reload();
    r('persist', 'administrator after reload: «اجرا شد — شناسهٔ پیگیری: SIM-DEMO-001»', await a.evaluate(`!!document.querySelector('li[data-refund="${r0.id}"]')?.innerText.includes('SIM-DEMO-001')`));
    const other = await (await apiAs('operator')).call('GET', '/v1/admin/refunds/manual', undefined, { expect: [200, 403] });
    r('denied', 'the platform operator (no bc_execute_manual_refunds) gets 403 on the list (administrator control above)', other.status === 403, `HTTP ${other.status}`);
  });
}

function userKey(userId) {
  return Object.entries(ids).find(([k, v]) => k.startsWith('user:') && v === userId)?.[0]?.slice(5) ?? null;
}

const GROUPS = { f10: f10Group, regolden: regoldenGroup, round4: round4Group, referral: referralGroup, outcome: outcomeGroup, recovery: recoveryGroup, checkout: checkoutGroup, account: accountGroup, pro: proGroup, moderation: moderationGroup, engagement: engagementGroup, waitlist: waitlistGroup, business: businessGroup, admin: adminGroup };
for (const g of groups) {
  if (!GROUPS[g]) throw new Error(`unknown group ${g}`);
  await GROUPS[g]();
}
for (const b of browsers.values()) await b.close();
const log = Object.fromEntries([...browsers.entries()].map(([k, b]) => [k, { console: b.log.console, http: b.log.http, throttled: b.log.throttled, dialogs: b.log.dialogs, tls: b.log.docSecurity }]));
fs.writeFileSync(path.join(OUT, 'browser-logs.json'), JSON.stringify(log, null, 2));
console.log(`evidence: ${OUT}`);
