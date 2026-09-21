import type { ReferralClaimResult, ReferralCodeView } from '@beauclick/referral-contract';
import { REFERRAL_CLAIM_REFUSED_CODE } from '@beauclick/referral-contract';
import { ApiRequestError, type ApiClient } from './api-client';

/**
 * The two referral routes, and how a refused claim is read.
 *
 * Only two routes exist (`GET /v1/me/referral/code`, `POST /v1/me/referral/claim`)
 * and neither reads a referral's status — see `39_REFERRAL.md`. The types come
 * from `@beauclick/referral-contract`, the one definition the server and this
 * page share.
 */

/** The caller's own code, minted on first read. Idempotent: the code never changes. */
export function referralCode(api: ApiClient) {
  return api.get<ReferralCodeView>('/v1/me/referral/code');
}

/** The code is the ONLY field the server accepts; anything else is a 400. */
export function claimReferral(api: ApiClient, code: string) {
  return api.post<ReferralClaimResult>('/v1/me/referral/claim', { code });
}

/**
 * What a failed claim means to the customer.
 *
 * `refused` is ONE answer for all six eligibility causes (unknown, revoked, own
 * code, already attributed, account too old, already booked) — the server
 * refuses to say which, so the page must not try to. `throttled` and `invalid`
 * are not answers about eligibility; anything else is an ordinary failure.
 */
export type ClaimFailure = 'refused' | 'throttled' | 'invalid' | 'failed';

export function classifyClaimFailure(error: unknown): ClaimFailure {
  if (!(error instanceof ApiRequestError)) return 'failed';
  if (error.status === 409 && error.code === REFERRAL_CLAIM_REFUSED_CODE) return 'refused';
  if (error.status === 429) return 'throttled';
  if (error.status === 400) return 'invalid';
  return 'failed';
}
