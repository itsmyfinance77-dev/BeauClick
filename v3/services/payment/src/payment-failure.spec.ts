import {
  PAYMENT_FAILURE_REASONS,
  isPaymentFailureReason,
  isRetryableFailureReason,
  toPublicFailureReason,
  unresolvedVerification,
} from './payment-failure';

/**
 * The public failure vocabulary (`QA-21`).
 *
 * The property under test is not "the mapping table is correct" -- a table is
 * self-evident. It is that **no provider string can escape the closed set**,
 * because that set is what ends up in a redirect URL, and a redirect URL is
 * browser history, a referrer header, and whatever analytics the result page
 * loads.
 */
describe('payment failure reasons', () => {
  describe('toPublicFailureReason', () => {
    it('distinguishes a customer cancelling from a bank declining — the whole point of QA-21', () => {
      expect(toPublicFailureReason('cancelled_by_user')).toBe('cancelled_by_user');
      expect(toPublicFailureReason('declined')).toBe('declined');
    });

    it('maps the internal codes the payment service itself produces', () => {
      expect(toPublicFailureReason('intent_expired')).toBe('expired');
      expect(toPublicFailureReason('amount_mismatch')).toBe('amount_mismatch');
      expect(toPublicFailureReason('verification_timeout')).toBe('unresolved');
      expect(toPublicFailureReason('verification_transport_error')).toBe('unresolved');
    });

    it('maps every code the sandbox provider can return', () => {
      // If a provider gains a code and forgets this table, the fallback below
      // catches it -- but the sandbox is the one adapter that exists, so its
      // codes are pinned rather than left to the fallback.
      expect(toPublicFailureReason('unknown_reference')).toBe('unknown_reference');
      expect(toPublicFailureReason('not_completed')).toBe('not_completed');
      expect(toPublicFailureReason('declined')).toBe('declined');
      expect(toPublicFailureReason('cancelled_by_user')).toBe('cancelled_by_user');
    });

    it('is case- and whitespace-insensitive, because a gateway is not obliged to be tidy', () => {
      expect(toPublicFailureReason('  DECLINED ')).toBe('declined');
      expect(toPublicFailureReason('Cancelled_By_User')).toBe('cancelled_by_user');
    });

    it('never echoes an unrecognised provider code — it becomes gateway_error', () => {
      // The security property. A real Iranian gateway's code may be numeric,
      // Persian free text, or carry a reference; none of it may reach a URL.
      for (const hostile of [
        '-51',
        'NOK: merchant 1234-5678 rejected authority A00000000000000000000000000123456789',
        'کارت مسدود است',
        '<script>alert(1)</script>',
        'https://evil.example/callback',
      ]) {
        const reason = toPublicFailureReason(hostile);
        expect(reason).toBe('gateway_error');
        expect(PAYMENT_FAILURE_REASONS).toContain(reason);
      }
    });

    it('returns null for no failure, rather than inventing one for a successful payment', () => {
      expect(toPublicFailureReason(null)).toBeNull();
      expect(toPublicFailureReason(undefined)).toBeNull();
      expect(toPublicFailureReason('')).toBeNull();
      expect(toPublicFailureReason('   ')).toBeNull();
    });

    it('only ever answers with a member of the closed set', () => {
      const inputs = ['declined', 'anything', '', '   ', '0', 'NULL', 'undefined', '__proto__', 'constructor', 'toString'];
      for (const input of inputs) {
        const reason = toPublicFailureReason(input);
        if (reason !== null) expect(PAYMENT_FAILURE_REASONS).toContain(reason);
      }
    });

    it('does not resolve inherited Object properties as reasons', () => {
      // `REASON_ALIASES` is an object literal, so a lookup of `toString` or
      // `constructor` would find a FUNCTION on the prototype chain and return
      // it as though it were a reason. It must not.
      expect(toPublicFailureReason('toString')).toBe('gateway_error');
      expect(toPublicFailureReason('constructor')).toBe('gateway_error');
      expect(toPublicFailureReason('__proto__')).toBe('gateway_error');
      expect(toPublicFailureReason('hasOwnProperty')).toBe('gateway_error');
    });
  });

  describe('isPaymentFailureReason', () => {
    it('accepts every declared reason and nothing else', () => {
      for (const reason of PAYMENT_FAILURE_REASONS) expect(isPaymentFailureReason(reason)).toBe(true);
      for (const other of ['succeeded', '', null, undefined, 42, {}]) {
        expect(isPaymentFailureReason(other)).toBe(false);
      }
    });
  });

  describe('isRetryableFailureReason', () => {
    it('invites a retry only where retrying is safe and could plausibly work', () => {
      expect(isRetryableFailureReason('cancelled_by_user')).toBe(true);
      expect(isRetryableFailureReason('declined')).toBe(true);
      expect(isRetryableFailureReason('not_completed')).toBe(true);
      expect(isRetryableFailureReason('gateway_error')).toBe(true);
    });

    it('refuses a retry where the money may already have moved or a security question is open', () => {
      // These two are the reason this predicate lives on the server. Retrying
      // an `unresolved` payment is how a customer gets charged twice, and
      // retrying an `amount_mismatch` reruns an open investigation.
      expect(isRetryableFailureReason('unresolved')).toBe(false);
      expect(isRetryableFailureReason('amount_mismatch')).toBe(false);
      expect(isRetryableFailureReason('unknown_reference')).toBe(false);
      expect(isRetryableFailureReason('expired')).toBe(false);
      expect(isRetryableFailureReason(null)).toBe(false);
    });
  });

  describe('unresolvedVerification', () => {
    it('produces an outcome that can never be mistaken for a settlement', () => {
      const result = unresolvedVerification('verification_timeout');
      expect(result.outcome).toBe('unknown');
      // All three must be null: an ambiguous verification learned NOTHING, and
      // a non-null amount here would flow into the amount-comparison path.
      expect(result.paidAmountToman).toBeNull();
      expect(result.paidCurrency).toBeNull();
      expect(result.providerTransactionId).toBeNull();
      expect(result.failureCode).toBe('verification_timeout');
    });
  });
});
