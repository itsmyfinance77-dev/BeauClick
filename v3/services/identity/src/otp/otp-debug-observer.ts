/**
 * V2 precedent (WORDPRESS_EXIT_MATRIX.md §6): `beauclick/auth/otp_generated`
 * had zero production subscribers -- it existed solely so tests could
 * observe a real generated code without a public return-value path, and
 * V3_EVENT_CATALOG.md's closing note is explicit that this must never
 * become a real, persisted event. Same shape here: an injectable, no-op-
 * by-default observer that ONLY a test module overrides. OtpService never
 * returns, logs, or persists a plaintext code anywhere else.
 */
export const OTP_DEBUG_OBSERVER = Symbol('OTP_DEBUG_OBSERVER');

export interface OtpDebugObserver {
  onCodeGenerated(phone: string, code: string): void;
}

export class NoopOtpDebugObserver implements OtpDebugObserver {
  onCodeGenerated(): void {
    // Intentionally does nothing in every real environment.
  }
}
