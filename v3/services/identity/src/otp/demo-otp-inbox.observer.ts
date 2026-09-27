/**
 * DEMO BRANCH ONLY (`codex/demo-2026-09-28`) — never merged to master.
 *
 * Delivers the one-time code the REAL `OtpService` generated to the local demo
 * inbox simulator, which stands in for the SMS gateway GAP-11 has not selected.
 * The owner approved this for the team demo (DEMO_PROGRESS.md, Milestone 1b):
 * the product's request-otp / verify-otp flow runs unchanged, and nothing here
 * creates, verifies, skips or weakens an OTP.
 *
 * Opt-in and fail-closed:
 *  - `DEMO_OTP_INBOX` must be exactly `1`; otherwise the ordinary no-op observer
 *    is bound and nothing changes;
 *  - with the flag set under `NODE_ENV=production` the process REFUSES TO BOOT
 *    (a demo seam must never be one variable away from production);
 *  - the inbox URL must be https on a loopback host, the bearer token at least
 *    32 characters, and the synthetic allow-list non-empty — any violation
 *    refuses to boot rather than silently delivering somewhere else;
 *  - a code for a phone that is not on the synthetic allow-list is NOT delivered.
 *
 * The code and the phone number are never logged here.
 */
import { Logger } from '@nestjs/common';

import { NoopOtpDebugObserver, OtpDebugObserver } from './otp-debug-observer';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const CANONICAL_PHONE = /^\+989\d{9}$/;

export class DemoOtpInboxObserver implements OtpDebugObserver {
  private readonly logger = new Logger('DemoOtpInbox');

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly allowedPhones: ReadonlySet<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  onCodeGenerated(phone: string, code: string): void {
    if (!this.allowedPhones.has(phone)) {
      this.logger.warn('Code not delivered: recipient is not on the demo synthetic allow-list.');
      return;
    }
    // Fire-and-forget: OtpService's contract is synchronous and a failed delivery
    // only means the person requests a new code, exactly as with a real gateway.
    void this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ to: phone, text: `کد ورود بیوکلیک (دمو): ${code}`, kind: 'otp' }),
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => {
        if (!response.ok) this.logger.warn(`Demo inbox refused a login-code delivery (HTTP ${response.status}).`);
      })
      .catch(() => this.logger.warn('Demo inbox unreachable; login code not delivered.'));
  }
}

export function otpObserverFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): OtpDebugObserver {
  if (env.DEMO_OTP_INBOX !== '1') return new NoopOtpDebugObserver();

  if (env.NODE_ENV === 'production') {
    throw new Error('DEMO_OTP_INBOX is set under NODE_ENV=production. The demo inbox adapter is refused in production.');
  }

  const rawUrl = env.DEMO_OTP_INBOX_URL?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DEMO_OTP_INBOX_URL is not an absolute URL.');
  }
  if (url.protocol !== 'https:') throw new Error('DEMO_OTP_INBOX_URL must be https.');
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error('DEMO_OTP_INBOX_URL must point at a loopback host.');

  const token = env.DEMO_OTP_INBOX_TOKEN?.trim() ?? '';
  if (token.length < 32) throw new Error('DEMO_OTP_INBOX_TOKEN must be at least 32 characters.');

  const phones = (env.DEMO_SYNTHETIC_PHONES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (phones.length === 0) throw new Error('DEMO_SYNTHETIC_PHONES is empty; the demo inbox would deliver to nobody.');
  const invalid = phones.filter((p) => !CANONICAL_PHONE.test(p));
  if (invalid.length > 0) throw new Error(`DEMO_SYNTHETIC_PHONES has ${invalid.length} entry(ies) not in canonical +989XXXXXXXXX form.`);

  return new DemoOtpInboxObserver(url.toString(), token, new Set(phones), fetchImpl);
}
