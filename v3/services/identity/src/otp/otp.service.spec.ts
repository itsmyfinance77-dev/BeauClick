import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createInMemoryDataSource } from '@beauclick/testing';
import { OtpService } from './otp.service';
import { OtpRequestEntity } from '../entities/otp-request.entity';
import { CapturingOtpObserver } from './otp-debug-observer.test-helper';

const CONFIG = {
  OTP_EXPIRY_SECONDS: '2',
  OTP_MAX_ATTEMPTS: '3',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_PER_PHONE_PER_HOUR: '5',
  OTP_MAX_PER_IP_PER_HOUR: '1000',
  OTP_HMAC_SECRET: 'test-secret',
} as Record<string, string>;

function fakeConfigService(): ConfigService {
  return { get: (key: string) => CONFIG[key] } as unknown as ConfigService;
}

describe('OtpService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let service: OtpService;
  let observer: CapturingOtpObserver;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([OtpRequestEntity]);
    observer = new CapturingOtpObserver();
    service = new OtpService(dataSource.getRepository(OtpRequestEntity), fakeConfigService(), observer);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('verifies successfully with the real generated code', async () => {
    await service.requestOtp('+989121234567', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234567');

    const result = await service.verifyOtp('+989121234567', code, 'login');
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong code without consuming the real one', async () => {
    await service.requestOtp('+989121234568', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234568');
    const wrong = code === '111111' ? '222222' : '111111';

    const wrongResult = await service.verifyOtp('+989121234568', wrong, 'login');
    expect(wrongResult.ok).toBe(false);

    const realResult = await service.verifyOtp('+989121234568', code, 'login');
    expect(realResult.ok).toBe(true);
  });

  it('rejects an expired code', async () => {
    await service.requestOtp('+989121234569', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234569');
    await new Promise((r) => setTimeout(r, 2100));

    const result = await service.verifyOtp('+989121234569', code, 'login');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid_or_expired');
  });

  it('a code can only be consumed once (replay prevention)', async () => {
    await service.requestOtp('+989121234570', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234570');

    expect((await service.verifyOtp('+989121234570', code, 'login')).ok).toBe(true);
    expect((await service.verifyOtp('+989121234570', code, 'login')).ok).toBe(false);
  });

  it('locks the code out after the configured max wrong attempts (test config: 3)', async () => {
    await service.requestOtp('+989121234571', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234571');
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 0; i < 3; i += 1) {
      await service.verifyOtp('+989121234571', wrong, 'login');
    }

    const result = await service.verifyOtp('+989121234571', code, 'login');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('too_many_attempts');
  });

  it('a code requested for one purpose never verifies for a different purpose', async () => {
    await service.requestOtp('+989121234572', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234572');

    const wrongPurpose = await service.verifyOtp('+989121234572', code, 'change_phone');
    expect(wrongPurpose.ok).toBe(false);

    const rightPurpose = await service.verifyOtp('+989121234572', code, 'login');
    expect(rightPurpose.ok).toBe(true);
  });

  it('enforces the per-phone hourly rate limit (test config: 5)', async () => {
    const phone = '+989121234573';
    for (let i = 0; i < 5; i += 1) {
      await service.requestOtp(phone, 'login', `10.0.0.${i}`);
    }
    await expect(service.requestOtp(phone, 'login', '10.0.0.99')).rejects.toThrow();
  });

  it('never stores the plaintext code anywhere in the persisted row', async () => {
    await service.requestOtp('+989121234574', 'login', '1.2.3.4');
    const code = observer.lastCodeFor('+989121234574');

    const repo = dataSource.getRepository(OtpRequestEntity);
    const row = await repo.findOneOrFail({ where: { phone: '+989121234574' } });
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash.length).toBeGreaterThan(6); // a real hash, not the raw code
  });
});
