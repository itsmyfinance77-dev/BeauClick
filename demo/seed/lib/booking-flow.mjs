// The customer's real checkout path, step for step:
//   (governed seller) GET /v1/checkout/disclosure -> the customer accepts exactly
//   the disclosed versions -> POST /v1/bookings (Idempotency-Key) -> the browser is
//   sent to the sandbox gateway -> the customer's decision on the simulated bank page
//   (POST /v1/sandbox-gateway/:ref/decide) -> the browser follows the gateway's
//   callback (GET, server-side verification decides the outcome).
import { randomUUID } from 'node:crypto';

import { rawRequest } from './client.mjs';

const items = (d) => (Array.isArray(d) ? d : d?.items ?? d?.value ?? []);

export async function publicSlots(session, professionalId, serviceId) {
  return items((await session.get(`/v1/providers/${professionalId}/availability?serviceId=${serviceId}`)).data);
}

/**
 * @param decision 'success' | 'failure' | 'cancel' | null (null = customer never decides: pending)
 */
export async function checkout(customer, { professionalId, serviceId, slotId, governed = false, decision = 'success' }) {
  let acceptedPolicy;
  if (governed) {
    const d = (await customer.get(`/v1/checkout/disclosure?professionalId=${professionalId}&slotId=${slotId}&serviceId=${serviceId}`)).data;
    const a = d?.acceptance ?? d?.policy ?? d;
    acceptedPolicy = {
      policyKey: a.policyKey,
      policyVersion: a.policyVersion,
      copyKey: a.copyKey ?? d?.copy?.copyKey,
      copyVersion: a.copyVersion ?? d?.copy?.copyVersion,
    };
  }
  const res = await customer.post(
    '/v1/bookings',
    { professionalId, slotId, serviceId, ...(acceptedPolicy ? { acceptedPolicy } : {}) },
    { headers: { 'Idempotency-Key': randomUUID() } },
  );
  const out = { bookingId: res.data.booking?.id, orderId: res.data.order?.id ?? res.data.order?.order?.id, redirectUrl: res.data.payment?.redirectUrl, decision };
  if (!out.redirectUrl || decision === null) return out;

  const redirect = new URL(out.redirectUrl, customer.origin);
  const reference = redirect.searchParams.get('reference');
  const callback = redirect.searchParams.get('callback');
  // The simulated bank's own page posts the decision, unauthenticated, exactly as the web page does.
  const decided = await rawRequest(`${customer.origin}/api/v1/sandbox-gateway/${encodeURIComponent(reference)}/decide`, {
    method: 'POST',
    body: { decision },
  });
  if (decided.status >= 300) throw new Error(`sandbox decide failed: HTTP ${decided.status}`);
  const back = await rawRequest(`${callback}${callback.includes('?') ? '&' : '?'}reference=${encodeURIComponent(reference)}`);
  out.callbackStatus = back.status;
  out.resultLocation = back.headers.location;
  return out;
}

/** Tehran wall-clock helpers for slot planning. */
export function tehranDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function tehranHour(iso) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}
export function tehranDay(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
