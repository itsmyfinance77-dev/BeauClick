import { OtpDebugObserver } from './otp-debug-observer';

/** Test-only capturing implementation -- see otp-debug-observer.ts for why this is the only way a test can observe a generated code. */
export class CapturingOtpObserver implements OtpDebugObserver {
  private codesByPhone = new Map<string, string>();

  onCodeGenerated(phone: string, code: string): void {
    this.codesByPhone.set(phone, code);
  }

  lastCodeFor(phone: string): string {
    const code = this.codesByPhone.get(phone);
    if (!code) throw new Error(`No OTP code was ever captured for ${phone} -- did requestOtp run first?`);
    return code;
  }
}
