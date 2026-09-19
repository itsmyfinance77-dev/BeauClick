/**
 * The settlement schedule and seller risk-class contract — V3.3 Story #175
 * (`#43d`), ADR-052 §1 and §8, `V33-DEC-040` R4, ratified by `V33-DEC-044`.
 *
 * Browser-safe and implementation-free, like the commission contract beside
 * it: `commercial` publishes schedules and classifies sellers, `#43e` will
 * propose settlements from them, and neither may import the other's
 * implementation. This file is the vocabulary they share.
 *
 * ## It carries no value
 *
 * No interval, minimum, reserve rate, cap or class assignment appears below.
 * In particular **7 does not**: if the platform settles weekly it is because
 * an administrator published 7, and the row records who and when. Every
 * constant here is a BOUNDARY or a closed VOCABULARY, and
 * `commercial.settlement_schedule_policy_versions` repeats each one as a SQL
 * CHECK, so a member added here and not there is refused by the database.
 */

/** The longest interval anybody may publish. A boundary, not a cadence. */
export const MAX_SETTLEMENT_INTERVAL_DAYS = 365;

/** 100% in basis points, shared with the commission family. A boundary, not a reserve. */
export const MAX_RESERVE_BASIS_POINTS = 10_000;

/** The representational ceiling every Toman amount in this family shares. */
export const MAX_SETTLEMENT_AMOUNT_TOMAN = 10_000_000_000_000;

/**
 * `V33-DEC-040` R4's closed set. There is no third member, and — the part
 * that matters — no DEFAULT member: a seller with no assignment has NO class,
 * which `#43e` must read as `unresolved` rather than as `standard`.
 */
export const SELLER_RISK_CLASSES = ['standard', 'elevated'] as const;
export type SellerRiskClass = (typeof SELLER_RISK_CLASSES)[number];

/**
 * One published schedule, as a resolver hands it over. Every field is a VALUE:
 * nothing here is a reference the reader must dereference later, for the same
 * reason the commission snapshot copies its rule.
 */
export interface SettlementScheduleTermsV1 {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly planKey: string;
  readonly riskClass: SellerRiskClass;
  readonly settlementIntervalDays: number;
  /** Null means NO minimum — a distinct state from zero, which would mean "propose any amount". */
  readonly minimumPayoutToman: number | null;
  /** Null means no reserve at all. A rate without a cap is an uncapped reserve, which is legitimate. */
  readonly reserveBasisPoints: number | null;
  readonly reserveCapToman: number | null;
}

/**
 * Why a seller has no schedule. Each member is a DIFFERENT fact, and `#43e`
 * must be able to tell them apart: an unclassified seller is an operational
 * gap somebody must close, while an unpublished plan is a commercial decision
 * nobody has made.
 */
export const SETTLEMENT_UNRESOLVED_CAUSES = ['no_risk_class', 'no_active_schedule'] as const;
export type SettlementUnresolvedCause = (typeof SETTLEMENT_UNRESOLVED_CAUSES)[number];

/**
 * The resolver's answer. There is deliberately no third shape carrying a
 * "default" schedule: `V33-DEC-040` R4 forbids inferring a class, and a
 * default cadence would be the same inference wearing a different name.
 */
export type ResolvedSettlementSchedule =
  | { readonly outcome: 'resolved'; readonly terms: SettlementScheduleTermsV1 }
  | { readonly outcome: 'unresolved'; readonly cause: SettlementUnresolvedCause };

/**
 * What a seller may be told about their own risk class (ADR-027, #175's
 * preflight). The CLASS and the instant — never the administrator's free-text
 * reason, which in practice encodes risk and fraud-detection signal, and
 * never the administrator's identity.
 */
export interface SellerRiskClassDisclosureV1 {
  readonly riskClass: SellerRiskClass;
  readonly assignedAt: string;
}
