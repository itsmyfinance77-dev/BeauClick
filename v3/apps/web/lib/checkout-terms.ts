/**
 * DEMO BRANCH ONLY (DEMO-DEC-001, part A) — never merged to master.
 *
 * The customer's view of the server's checkout disclosure
 * (`GET /v1/checkout/disclosure`, `BookingOutcomeDisclosureV1`) and of the terms
 * a booking was accepted under (`GET /v1/bookings/:id/accepted-terms`).
 *
 * Rules this module exists to keep in one place:
 *  - acceptance is only ever the four identifiers the server DISCLOSED, sent
 *    verbatim; nothing here constructs or defaults one;
 *  - an unenrolled seller's disclosure carries no terms and no acceptance, and
 *    this module never invents either;
 *  - "the terms changed" is decided by comparing identifiers, never by content.
 */
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';

import type { ApiClient } from './api-client';
import type { BookingOutcomeRetentionRule } from './pro-api';

export interface OutcomeAcceptance {
  policyKey: string;
  policyVersion: number;
  copyKey: string;
  copyVersion: number;
}

export interface CheckoutDisclosure {
  sellerParty: { kind: 'professional' | 'business'; displayName: string };
  amounts: { serviceTotalToman: number; platformCollectibleNowToman: number; venueBalanceToman: number };
  slotStartsAt: string;
  displayTimeZone: string;
  acceptanceRequired: boolean;
  outcome: null | {
    cutoffHours: number;
    cutoffInstant: string;
    lateCancellationRetention: BookingOutcomeRetentionRule;
    noShowGraceMinutes: number;
    noShowRetention: BookingOutcomeRetentionRule;
    rescheduleFreeCountBeforeCutoff: number;
    disputeWindowHours: number;
    bodilyHarmWindowHours: number | null;
    appealWindowHours: number;
    copy: { locale: string; body: string; bodySha256: string; publishedAt: string };
  };
  acceptance: OutcomeAcceptance | null;
}

export type AcceptedTerms =
  | { governed: false }
  | {
      governed: true;
      acceptedAt: string;
      policy: { policyKey: string; policyVersion: number };
      copy: { copyKey: string; copyVersion: number; locale: string | null; body: string | null; bodySha256: string | null };
      terms: {
        cutoffHours: number;
        cutoffInstant: string;
        lateCancellationRetention: BookingOutcomeRetentionRule;
        noShowGraceMinutes: number;
        noShowRetention: BookingOutcomeRetentionRule;
        rescheduleFreeCountBeforeCutoff: number;
        disputeWindowHours: number;
        bodilyHarmWindowHours: number | null;
        appealWindowHours: number;
      };
    };

export function loadDisclosure(api: ApiClient, q: { professionalId: string; serviceId: string; slotId: string }) {
  const params = new URLSearchParams(q);
  return api.get<CheckoutDisclosure>(`/v1/checkout/disclosure?${params.toString()}`);
}

export function loadAcceptedTerms(api: ApiClient, bookingId: string) {
  return api.get<AcceptedTerms>(`/v1/bookings/${encodeURIComponent(bookingId)}/accepted-terms`);
}

export function sameAcceptance(a: OutcomeAcceptance | null, b: OutcomeAcceptance | null): boolean {
  if (a === null || b === null) return a === b;
  return a.policyKey === b.policyKey && a.policyVersion === b.policyVersion && a.copyKey === b.copyKey && a.copyVersion === b.copyVersion;
}

/** Customer-facing wording of a retention rule (percentages, not basis points). */
export function customerRetention(rule: BookingOutcomeRetentionRule): string {
  switch (rule.kind) {
    case 'none':
      return 'چیزی از مبلغ پرداخت‌شده کسر نمی‌شود';
    case 'full_collected':
      return 'کل مبلغ پرداخت‌شده نگه داشته می‌شود';
    case 'percentage_of_collected':
      return `${toPersianDigits(String(rule.basisPoints / 100))}٪ مبلغ پرداخت‌شده نگه داشته می‌شود`;
    case 'fixed_toman':
      return `${formatToman(rule.amountToman)} تومان نگه داشته می‌شود`;
  }
}

/** The instant in the platform's display zone (Tehran), as the server intends it to be read. */
export function tehranDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    calendar: 'persian',
  }).format(new Date(iso));
}
