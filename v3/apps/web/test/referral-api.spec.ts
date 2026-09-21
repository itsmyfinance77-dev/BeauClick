import { REFERRAL_CLAIM_REFUSED_CODE } from '@beauclick/referral-contract';
import { ApiRequestError } from '@/lib/api-client';
import { classifyClaimFailure } from '@/lib/referral-api';

/**
 * A refused claim is ONE answer for six causes, and the page must not invent
 * more. These pin how a failed claim is read, against the contract's own code.
 */
describe('classifyClaimFailure', () => {
  it('reads the contract’s refusal code on a 409 as the one collapsed refusal', () => {
    expect(classifyClaimFailure(new ApiRequestError(REFERRAL_CLAIM_REFUSED_CODE, 'x', 409))).toBe('refused');
  });

  it('does not read a 409 with another code as a refusal — that is not the eligibility answer', () => {
    expect(classifyClaimFailure(new ApiRequestError('SOMETHING_ELSE', 'x', 409))).toBe('failed');
  });

  it('reads a 429 as a spent throttle and a 400 as a malformed request, each apart from a refusal', () => {
    expect(classifyClaimFailure(new ApiRequestError('REFERRAL_CLAIM_THROTTLED', 'x', 429))).toBe('throttled');
    expect(classifyClaimFailure(new ApiRequestError('VALIDATION_ERROR', 'x', 400))).toBe('invalid');
  });

  it('reads anything else — a 500, a network error, a non-API error — as a plain failure', () => {
    expect(classifyClaimFailure(new ApiRequestError('INTERNAL', 'x', 500))).toBe('failed');
    expect(classifyClaimFailure(new TypeError('Failed to fetch'))).toBe('failed');
    expect(classifyClaimFailure(undefined)).toBe('failed');
  });
});
