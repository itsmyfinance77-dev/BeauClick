import { Logger } from '@nestjs/common';

import { NoopOtpDebugObserver } from './otp-debug-observer';
import { DemoOtpInboxObserver, otpObserverFromEnv } from './demo-otp-inbox.observer';

const TOKEN = 'x'.repeat(40);
const PHONE = '+989120000401';
const base = {
  DEMO_OTP_INBOX: '1',
  NODE_ENV: 'development',
  DEMO_OTP_INBOX_URL: 'https://127.0.0.1:58445/ingest',
  DEMO_OTP_INBOX_TOKEN: TOKEN,
  DEMO_SYNTHETIC_PHONES: `${PHONE},+989120000402`,
} as NodeJS.ProcessEnv;

describe('otpObserverFromEnv (demo branch only)', () => {
  it('binds the ordinary no-op observer unless DEMO_OTP_INBOX is exactly "1"', () => {
    expect(otpObserverFromEnv({ ...base, DEMO_OTP_INBOX: undefined })).toBeInstanceOf(NoopOtpDebugObserver);
    expect(otpObserverFromEnv({ ...base, DEMO_OTP_INBOX: 'true' })).toBeInstanceOf(NoopOtpDebugObserver);
    expect(otpObserverFromEnv({ ...base, DEMO_OTP_INBOX: '0' })).toBeInstanceOf(NoopOtpDebugObserver);
  });

  it('refuses to boot under NODE_ENV=production when the flag is set', () => {
    expect(() => otpObserverFromEnv({ ...base, NODE_ENV: 'production' })).toThrow(/refused in production/);
  });

  it('is inert under NODE_ENV=production when the flag is absent', () => {
    expect(otpObserverFromEnv({ NODE_ENV: 'production' })).toBeInstanceOf(NoopOtpDebugObserver);
  });

  it.each([
    ['plain http', { DEMO_OTP_INBOX_URL: 'http://127.0.0.1:58445/ingest' }, /https/],
    ['a non-loopback host', { DEMO_OTP_INBOX_URL: 'https://10.20.30.6:58445/ingest' }, /loopback/],
    ['a public host', { DEMO_OTP_INBOX_URL: 'https://sms.example.com/send' }, /loopback/],
    ['a relative URL', { DEMO_OTP_INBOX_URL: '/ingest' }, /absolute/],
    ['a short token', { DEMO_OTP_INBOX_TOKEN: 'short' }, /32 characters/],
    ['an empty allow-list', { DEMO_SYNTHETIC_PHONES: ' , ' }, /empty/],
    ['a non-canonical phone', { DEMO_SYNTHETIC_PHONES: '09120000401' }, /canonical/],
  ])('refuses to boot with %s', (_label, override, message) => {
    expect(() => otpObserverFromEnv({ ...base, ...override } as NodeJS.ProcessEnv)).toThrow(message);
  });

  it('builds the inbox observer for a valid loopback configuration', () => {
    expect(otpObserverFromEnv(base)).toBeInstanceOf(DemoOtpInboxObserver);
  });
});

describe('DemoOtpInboxObserver', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void logs.push(String(m)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  const flush = () => new Promise((r) => setImmediate(r));

  it('posts an allow-listed code to the inbox with the bearer token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    const observer = otpObserverFromEnv(base, fetchImpl as unknown as typeof fetch);
    observer.onCodeGenerated(PHONE, '123456');
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://127.0.0.1:58445/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ to: PHONE, text: expect.stringContaining('123456'), kind: 'otp' });
  });

  it('does not deliver a code for a phone outside the synthetic allow-list', async () => {
    const fetchImpl = jest.fn();
    const observer = otpObserverFromEnv(base, fetchImpl as unknown as typeof fetch);
    observer.onCodeGenerated('+989351234567', '654321');
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toMatch(/654321|\+989351234567/);
  });

  it('never logs the code or the phone, on success or failure', async () => {
    const ok = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    const refused = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    const down = jest.fn().mockRejectedValue(new Error(`connect ECONNREFUSED for ${PHONE} code 111111`));
    for (const f of [ok, refused, down]) {
      otpObserverFromEnv(base, f as unknown as typeof fetch).onCodeGenerated(PHONE, '111111');
    }
    await flush();
    await flush();
    const all = logs.join('\n');
    expect(all).toMatch(/HTTP 403/);
    expect(all).toMatch(/unreachable/);
    expect(all).not.toContain('111111');
    expect(all).not.toContain(PHONE);
  });
});
