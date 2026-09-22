import type {
  BookingCollectionMode,
  BookingCollectionPercentageBase,
  BookingOutcomeRetentionRule,
  CatalogueLifecycleState,
  CustomerPolicyCopyLocale,
  LegalEvidenceReferenceKind,
  LegalEvidenceStatus,
  LegalEvidenceSubject,
  PriceSchedulePurpose,
} from '@beauclick/commercial-policy-contract';
import type { ApiClient } from './api-client';

/**
 * The administrator's commercial surfaces beyond commission (#239): the plan
 * and price catalogue (spec 40), the booking collection policies and the
 * booking-credit enforcement control plane (spec 44), and the booking-outcome
 * policies, customer policy copy and Legal evidence register (spec 47).
 *
 * Every shape here was read off its controller's own view function
 * (`commercial-catalogue.controller.ts`, `booking-credit-enforcement.controller.ts`,
 * `booking-outcome-policy.controller.ts`), field for field, and none carries a
 * `createdByUserId`, `publishedByUserId` or `retiredByUserId` because none of
 * the views returns one. Closed vocabularies are imported from
 * `@beauclick/commercial-policy-contract` rather than re-typed, so a value the
 * contract adds or drops is a compile error here.
 *
 * Every route is gated server-side on the privileged
 * `bc_manage_commercial_plans`, re-checked against live role data per request.
 * Every mutation carries a mandatory `reason` (`ReasonDto`: 3–500 characters)
 * and nothing that names an actor — the server takes the actor from the
 * session and refuses unknown fields outright.
 *
 * Note one absence that shapes a screen: no schedule read returns a version's
 * `id`, yet a plan version must reference one (`priceScheduleVersionId`). A new
 * plan version therefore cannot be drafted from this UI until the API returns
 * it — #271.
 */

const ROOT = '/v1/admin/commercial';
const seg = (value: string) => encodeURIComponent(value);

/** `ReasonDto` on every mutation. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The four fields every published-lifecycle version carries, whichever family it belongs to. */
export interface LifecycleVersion {
  version: number;
  lifecycleState: CatalogueLifecycleState;
  activationStartsAt: string | null;
  activationEndsAt: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
}

// ============================================================ price schedules

export interface PriceScheduleSummary {
  scheduleKey: string;
  purpose: PriceSchedulePurpose;
  createdAt: string;
}

export interface PriceScheduleVersion extends LifecycleVersion {
  scheduleKey: string;
  displayName: string;
  currency: string;
  minPurchaseQuantity: number;
  maxPurchaseQuantity: number;
  activationStartsAt: string;
}

export interface PriceTier {
  minQuantity: number;
  /** `null` is "no upper bound" — the only representation of it. */
  maxQuantity: number | null;
  unitPriceToman: number;
}

/** The single-version read adds the terms the list leaves out. */
export interface PriceScheduleVersionDetail extends PriceScheduleVersion {
  uiPresetQuantities: number[];
  tiers: PriceTier[];
}

/** `WriteScheduleVersionDto`. The currency is the server's (`IRT`) and is not sent. */
export interface PriceScheduleVersionBody {
  displayName: string;
  activationStartsAt: string;
  activationEndsAt: string | null;
  minPurchaseQuantity: number;
  maxPurchaseQuantity: number;
  uiPresetQuantities: number[];
  tiers: PriceTier[];
  reason: string;
}

export function priceSchedules(api: ApiClient) {
  return api.get<{ items: PriceScheduleSummary[] }>(`${ROOT}/price-schedules`);
}

export function createPriceSchedule(api: ApiClient, body: { scheduleKey: string; purpose: PriceSchedulePurpose; reason: string }) {
  return api.post<PriceScheduleSummary>(`${ROOT}/price-schedules`, body);
}

export function priceScheduleVersions(api: ApiClient, scheduleKey: string) {
  return api.get<{ items: PriceScheduleVersion[] }>(`${ROOT}/price-schedules/${seg(scheduleKey)}/versions`);
}

export function priceScheduleVersion(api: ApiClient, scheduleKey: string, version: number) {
  return api.get<PriceScheduleVersionDetail>(`${ROOT}/price-schedules/${seg(scheduleKey)}/versions/${version}`);
}

export function draftPriceScheduleVersion(api: ApiClient, scheduleKey: string, body: PriceScheduleVersionBody) {
  return api.post<PriceScheduleVersion>(`${ROOT}/price-schedules/${seg(scheduleKey)}/versions`, body);
}

export function replacePriceScheduleVersion(api: ApiClient, scheduleKey: string, version: number, body: PriceScheduleVersionBody) {
  return api.put<PriceScheduleVersion>(`${ROOT}/price-schedules/${seg(scheduleKey)}/versions/${version}`, body);
}

// ======================================================================= plans

export interface PlanSummary {
  planKey: string;
  createdAt: string;
}

export interface PlanVersion extends LifecycleVersion {
  planKey: string;
  displayName: string;
  /** `null` means the plan has no billing term. */
  billingTermDays: number | null;
  includedBookingCredits: number;
  staffSeats: number;
  includedLocations: number;
  capabilityKeys: string[];
  priceScheduleVersionId: string;
  bookingCreditScheduleKey: string | null;
  autoAssignable: boolean;
  activationStartsAt: string;
}

/** `WritePlanVersionDto`. */
export interface PlanVersionBody {
  displayName: string;
  billingTermDays: number | null;
  includedBookingCredits: number;
  staffSeats: number;
  includedLocations: number;
  capabilityKeys: string[];
  priceScheduleVersionId: string;
  bookingCreditScheduleKey: string | null;
  autoAssignable: boolean;
  activationStartsAt: string;
  activationEndsAt: string | null;
  reason: string;
}

export function plans(api: ApiClient) {
  return api.get<{ items: PlanSummary[] }>(`${ROOT}/plans`);
}

export function createPlan(api: ApiClient, body: { planKey: string; reason: string }) {
  return api.post<PlanSummary>(`${ROOT}/plans`, body);
}

export function planVersions(api: ApiClient, planKey: string) {
  return api.get<{ items: PlanVersion[] }>(`${ROOT}/plans/${seg(planKey)}/versions`);
}

export function replacePlanVersion(api: ApiClient, planKey: string, version: number, body: PlanVersionBody) {
  return api.put<PlanVersion>(`${ROOT}/plans/${seg(planKey)}/versions/${version}`, body);
}

// ======================================================== collection policies

export type CollectionDeposit =
  | { kind: 'none' }
  | { kind: 'fixed'; amountToman: number }
  | {
      kind: 'percentage';
      basisPoints: number;
      percentageBase: BookingCollectionPercentageBase;
      minimumToman: number;
      maximumToman: number | null;
    };

export interface CollectionPolicySummary {
  policyKey: string;
  displayName: string;
  createdAt: string;
}

export interface CollectionPolicyVersion extends LifecycleVersion {
  policyKey: string;
  collectionMode: BookingCollectionMode;
  deposit: CollectionDeposit;
  contractVersion: number;
}

/** `WriteBookingCollectionPolicyVersionDto`. No activation START: the server sets it at publication. */
export interface CollectionPolicyVersionBody {
  collectionMode: BookingCollectionMode;
  deposit: CollectionDeposit;
  activationEndsAt: string | null;
  reason: string;
}

export function collectionPolicies(api: ApiClient) {
  return api.get<{ items: CollectionPolicySummary[] }>(`${ROOT}/collection-policies`);
}

export function createCollectionPolicy(api: ApiClient, body: { policyKey: string; displayName: string; reason: string }) {
  return api.post<CollectionPolicySummary>(`${ROOT}/collection-policies`, body);
}

export function collectionPolicyVersions(api: ApiClient, policyKey: string) {
  return api.get<{ items: CollectionPolicyVersion[] }>(`${ROOT}/collection-policies/${seg(policyKey)}/versions`);
}

export function draftCollectionPolicyVersion(api: ApiClient, policyKey: string, body: CollectionPolicyVersionBody) {
  return api.post<CollectionPolicyVersion>(`${ROOT}/collection-policies/${seg(policyKey)}/versions`, body);
}

export function replaceCollectionPolicyVersion(api: ApiClient, policyKey: string, version: number, body: CollectionPolicyVersionBody) {
  return api.put<CollectionPolicyVersion>(`${ROOT}/collection-policies/${seg(policyKey)}/versions/${version}`, body);
}

// ================================================= booking-credit enforcement

/** `EnforcementStatus`. No audit id, no actor, no party. */
export interface EnforcementStatus {
  rolloutState: string;
  killSwitchState: string;
  activationGeneration: number;
  activatedAt: string | null;
  killSwitchChangedAt: string | null;
}

/** `EnforcementPreview` — aggregates only, and deliberately no seller-identifying data. */
export interface EnforcementPreview {
  rolloutState: string;
  killSwitchState: string;
  activationGeneration: number;
  eligible: number;
  governed: number;
  legacyExempt: number;
  unresolved: number;
  wouldBeRefused: number;
}

/** What a set-based command did: counts, never a party. */
export interface GovernanceOutcome {
  affected: number;
  skipped: number;
}

const ENFORCEMENT = `${ROOT}/booking-credit-enforcement`;

export function enforcementStatus(api: ApiClient) {
  return api.get<EnforcementStatus>(ENFORCEMENT);
}

export function enforcementPreview(api: ApiClient) {
  return api.get<EnforcementPreview>(`${ENFORCEMENT}/preview`);
}

/** Every enforcement command's body is EXACTLY a reason — there is no seller, party or state to name. */
export const ENFORCEMENT_COMMANDS = {
  transition: 'transitions',
  exempt: 'exemptions',
  engage: 'kill-switch/engage',
  release: 'kill-switch/release',
  activate: 'activation',
} as const;
export type EnforcementCommand = keyof typeof ENFORCEMENT_COMMANDS;

export function runEnforcementCommand(api: ApiClient, command: EnforcementCommand, reason: string) {
  return api.post<GovernanceOutcome | EnforcementStatus>(`${ENFORCEMENT}/${ENFORCEMENT_COMMANDS[command]}`, { reason });
}

// ============================================================ outcome policies

export interface OutcomePolicySummary {
  policyKey: string;
  displayName: string;
  createdAt: string;
}

export interface OutcomePolicyVersion extends LifecycleVersion {
  policyKey: string;
  cutoffHoursAllowed: number[];
  lateRetentionOptions: BookingOutcomeRetentionRule[];
  noShowGraceMinutesAllowed: number[];
  noShowRetentionOptions: BookingOutcomeRetentionRule[];
  rescheduleFreeCountBeforeCutoff: number;
  disputeWindowHours: number;
  bodilyHarmWindowHours: number | null;
  appealWindowHours: number;
  caseFileRetentionDays: number | null;
  legalCap: BookingOutcomeRetentionRule | null;
  legalEvidenceKey: string | null;
  contractVersion: number;
}

/** `WriteBookingOutcomePolicyVersionDto`. No activation START: the server sets it at publication. */
export interface OutcomePolicyVersionBody {
  cutoffHoursAllowed: number[];
  lateRetentionOptions: BookingOutcomeRetentionRule[];
  noShowGraceMinutesAllowed: number[];
  noShowRetentionOptions: BookingOutcomeRetentionRule[];
  rescheduleFreeCountBeforeCutoff: number;
  disputeWindowHours: number;
  bodilyHarmWindowHours: number | null;
  appealWindowHours: number;
  caseFileRetentionDays: number | null;
  legalCap: BookingOutcomeRetentionRule | null;
  legalEvidenceKey: string | null;
  activationEndsAt: string | null;
  reason: string;
}

export function outcomePolicies(api: ApiClient) {
  return api.get<{ items: OutcomePolicySummary[] }>(`${ROOT}/outcome-policies`);
}

export function createOutcomePolicy(api: ApiClient, body: { policyKey: string; displayName: string; reason: string }) {
  return api.post<OutcomePolicySummary>(`${ROOT}/outcome-policies`, body);
}

export function outcomePolicyVersions(api: ApiClient, policyKey: string) {
  return api.get<{ items: OutcomePolicyVersion[] }>(`${ROOT}/outcome-policies/${seg(policyKey)}/versions`);
}

export function draftOutcomePolicyVersion(api: ApiClient, policyKey: string, body: OutcomePolicyVersionBody) {
  return api.post<OutcomePolicyVersion>(`${ROOT}/outcome-policies/${seg(policyKey)}/versions`, body);
}

export function replaceOutcomePolicyVersion(api: ApiClient, policyKey: string, version: number, body: OutcomePolicyVersionBody) {
  return api.put<OutcomePolicyVersion>(`${ROOT}/outcome-policies/${seg(policyKey)}/versions/${version}`, body);
}

// ======================================================= customer policy copy

export interface PolicyCopySummary {
  copyKey: string;
  displayName: string;
  createdAt: string;
}

/** The list carries the body's hash, not the body. */
export interface PolicyCopyVersion extends LifecycleVersion {
  copyKey: string;
  locale: CustomerPolicyCopyLocale;
  bodySha256: string;
  contractVersion: number;
}

/** The single-version read and the write echoes also carry the text. */
export interface PolicyCopyVersionDetail extends PolicyCopyVersion {
  body: string;
}

export interface PolicyCopyVersionBody {
  locale: CustomerPolicyCopyLocale;
  body: string;
  activationEndsAt: string | null;
  reason: string;
}

export function policyCopies(api: ApiClient) {
  return api.get<{ items: PolicyCopySummary[] }>(`${ROOT}/customer-policy-copies`);
}

export function createPolicyCopy(api: ApiClient, body: { copyKey: string; displayName: string; reason: string }) {
  return api.post<PolicyCopySummary>(`${ROOT}/customer-policy-copies`, body);
}

export function policyCopyVersions(api: ApiClient, copyKey: string) {
  return api.get<{ items: PolicyCopyVersion[] }>(`${ROOT}/customer-policy-copies/${seg(copyKey)}/versions`);
}

export function policyCopyVersion(api: ApiClient, copyKey: string, version: number) {
  return api.get<PolicyCopyVersionDetail>(`${ROOT}/customer-policy-copies/${seg(copyKey)}/versions/${version}`);
}

export function draftPolicyCopyVersion(api: ApiClient, copyKey: string, body: PolicyCopyVersionBody) {
  return api.post<PolicyCopyVersionDetail>(`${ROOT}/customer-policy-copies/${seg(copyKey)}/versions`, body);
}

export function replacePolicyCopyVersion(api: ApiClient, copyKey: string, version: number, body: PolicyCopyVersionBody) {
  return api.put<PolicyCopyVersionDetail>(`${ROOT}/customer-policy-copies/${seg(copyKey)}/versions/${version}`, body);
}

// ============================================================== legal evidence

/** The list is vocabulary and instants only. */
export interface LegalEvidence {
  evidenceKey: string;
  subject: LegalEvidenceSubject;
  status: LegalEvidenceStatus;
  referenceKind: LegalEvidenceReferenceKind;
  recordedAt: string;
  retiredAt: string | null;
}

/** The single-record read adds the reference and summary. */
export interface LegalEvidenceDetail extends LegalEvidence {
  reference: string;
  summary: string;
}

export function legalEvidence(api: ApiClient) {
  return api.get<{ items: LegalEvidence[] }>(`${ROOT}/legal-evidence`);
}

export function legalEvidenceRecord(api: ApiClient, evidenceKey: string) {
  return api.get<LegalEvidenceDetail>(`${ROOT}/legal-evidence/${seg(evidenceKey)}`);
}

export function recordLegalEvidence(
  api: ApiClient,
  body: {
    evidenceKey: string;
    subject: LegalEvidenceSubject;
    referenceKind: LegalEvidenceReferenceKind;
    reference: string;
    summary: string;
    reason: string;
  },
) {
  return api.post<LegalEvidenceDetail>(`${ROOT}/legal-evidence`, body);
}

export function retireLegalEvidence(api: ApiClient, evidenceKey: string, reason: string) {
  return api.post<LegalEvidence>(`${ROOT}/legal-evidence/${seg(evidenceKey)}/retire`, { reason });
}

// ================================================ the shared version lifecycle

/**
 * The URL segment of each versioned family. Publish, retire and discard have
 * the same shape in all five, so one function each serves every family.
 */
export const VERSION_FAMILIES = {
  plan: 'plans',
  priceSchedule: 'price-schedules',
  collectionPolicy: 'collection-policies',
  outcomePolicy: 'outcome-policies',
  policyCopy: 'customer-policy-copies',
} as const;
export type VersionFamily = keyof typeof VERSION_FAMILIES;

const versionPath = (family: VersionFamily, key: string, version: number) =>
  `${ROOT}/${VERSION_FAMILIES[family]}/${seg(key)}/versions/${version}`;

export function publishVersion(api: ApiClient, family: VersionFamily, key: string, version: number, reason: string) {
  return api.post<LifecycleVersion>(`${versionPath(family, key, version)}/publish`, { reason });
}

export function retireVersion(api: ApiClient, family: VersionFamily, key: string, version: number, reason: string) {
  return api.post<LifecycleVersion>(`${versionPath(family, key, version)}/retire`, { reason });
}

/** DELETE with a body: discarding a draft is a mutation like any other, and carries its reason. */
export function discardVersion(api: ApiClient, family: VersionFamily, key: string, version: number, reason: string) {
  return api.delete<{ discarded: boolean }>(versionPath(family, key, version), { reason });
}
