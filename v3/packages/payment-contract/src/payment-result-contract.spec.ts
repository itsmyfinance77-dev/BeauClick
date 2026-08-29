import {
  PAYMENT_FAILURE_REASONS,
  PAYMENT_RESULT_STATUSES,
  PAYMENT_RETRY_REFUSALS,
  isPaymentFailureReason,
  isPaymentResultStatus,
  isPaymentRetryRefusal,
  isRetryableFailureReason,
  statusCarriesAReason,
} from './payment-result-contract';

/**
 * The shared contract.
 *
 * These assertions exist because this file is the ONE definition the server
 * and the browser both hold. If it were duplicated, a disagreement between the
 * two would be silent and would look like working code — a reason the page
 * offers a retry for that the server refuses, or the reverse.
 */
describe('payment result contract', () => {
  describe('statuses', () => {
    it('covers exactly the six the redirect can produce', () => {
      // Sourced from `PaymentCallbackController.handle`: three verification
      // outcomes plus the two post-success corrections plus `unresolved`.
      expect([...PAYMENT_RESULT_STATUSES].sort()).toEqual(
        ['duplicate_refunded', 'failed', 'refunded', 'replayed', 'succeeded', 'unresolved'].sort(),
      );
    });

    it('recognises its own members and nothing else', () => {
      for (const status of PAYMENT_RESULT_STATUSES) expect(isPaymentResultStatus(status)).toBe(true);
      for (const other of ['paid', 'pending', '', null, undefined, 0, {}, 'SUCCEEDED']) {
        expect(isPaymentResultStatus(other)).toBe(false);
      }
    });
  });

  describe('failure reasons', () => {
    it('covers exactly the eight public reasons', () => {
      expect(PAYMENT_FAILURE_REASONS).toHaveLength(8);
    });

    it('recognises its own members and nothing else', () => {
      for (const reason of PAYMENT_FAILURE_REASONS) expect(isPaymentFailureReason(reason)).toBe(true);
      for (const other of ['succeeded', 'declined_by_bank', '', null, undefined, 42, {}, 'DECLINED']) {
        expect(isPaymentFailureReason(other)).toBe(false);
      }
    });

    it('contains no provider-shaped code', () => {
      // The whole point of the closed set: every member is a word this
      // product chose, not a string a gateway produced.
      for (const reason of PAYMENT_FAILURE_REASONS) {
        expect(reason).toMatch(/^[a-z][a-z_]*$/);
      }
    });
  });

  describe('isRetryableFailureReason', () => {
    it('permits exactly the four where the gateway said no money moved', () => {
      const retryable = PAYMENT_FAILURE_REASONS.filter((r) => isRetryableFailureReason(r));
      expect([...retryable].sort()).toEqual(['cancelled_by_user', 'declined', 'gateway_error', 'not_completed'].sort());
    });

    it('refuses the four where a retry could cause harm', () => {
      // Each is a different harm, and the comment on the function says which.
      expect(isRetryableFailureReason('unresolved')).toBe(false);
      expect(isRetryableFailureReason('amount_mismatch')).toBe(false);
      expect(isRetryableFailureReason('unknown_reference')).toBe(false);
      expect(isRetryableFailureReason('expired')).toBe(false);
    });

    it('refuses absence rather than defaulting to permitted', () => {
      expect(isRetryableFailureReason(null)).toBe(false);
      expect(isRetryableFailureReason(undefined)).toBe(false);
    });

    it('classifies every declared reason, leaving none undecided', () => {
      for (const reason of PAYMENT_FAILURE_REASONS) {
        expect(typeof isRetryableFailureReason(reason)).toBe('boolean');
      }
    });
  });

  describe('statusCarriesAReason', () => {
    it('permits a reason only where the server attaches one', () => {
      expect(statusCarriesAReason('failed')).toBe(true);
      expect(statusCarriesAReason('unresolved')).toBe(true);
    });

    it('refuses it everywhere else', () => {
      // A `refunded` or `duplicate_refunded` outcome SUCCEEDED at the gateway
      // and was corrected afterwards; a failure reason would describe the
      // wrong event. And `?status=succeeded&reason=declined` must never render
      // a page that says both.
      for (const status of ['succeeded', 'replayed', 'refunded', 'duplicate_refunded', 'anything']) {
        expect(statusCarriesAReason(status)).toBe(false);
      }
    });
  });

  describe('retry refusals', () => {
    it('recognises its own members and nothing else', () => {
      for (const refusal of PAYMENT_RETRY_REFUSALS) expect(isPaymentRetryRefusal(refusal)).toBe(true);
      for (const other of ['forbidden', '', null, undefined, 1]) expect(isPaymentRetryRefusal(other)).toBe(false);
    });

    it('names no internal state and no provider code', () => {
      for (const refusal of PAYMENT_RETRY_REFUSALS) {
        expect(refusal).toMatch(/^[a-z][a-z_]*$/);
      }
    });
  });
});
