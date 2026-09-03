/**
 * The browser-safe half of ADR-042's subscription foundation.
 *
 * Zero dependencies, exactly like the two files beside it. No NestJS, TypeORM,
 * entity, user id, seller id, gateway or production enablement flag.
 *
 * ## Why this file exists at all in a story with no routes
 *
 * Story #56a ships no HTTP route — that is #69. `V33-DEC-018` still requires
 * the vocabulary to be defined once, browser-safe, because #69's contract and
 * this story's entities must agree on the same closed sets, and a vocabulary
 * duplicated in two places is a vocabulary waiting to disagree. The catalogue
 * made the same call for `CatalogueLifecycleState`.
 *
 * Nothing here is a value open under #46. There is no price, allowance, seat
 * count, location count, billing term or expiry period in this file, and no
 * default that a deployment could inherit.
 */

export const SELLER_SUBSCRIPTION_CONTRACT_VERSION = 1 as const;

/**
 * Who may hold a subscription (`V33-DEC-009`, `V33-DEC-018`).
 *
 * The same two parties `commerce.orders.seller_party_type` already recognises,
 * and deliberately not a third: a staff member is not a party, which is why an
 * affiliated professional cannot hold their employer's subscription.
 */
export const SUBSCRIBER_PARTY_TYPES = ['professional', 'business'] as const;
export type SubscriberPartyType = (typeof SUBSCRIBER_PARTY_TYPES)[number];

/**
 * `active -> superseded | cancelled`, one way, no return (`V33-DEC-018`).
 *
 * There is no `pending`, `awaiting_payment`, `draft` or `paid` member, and
 * their absence is a decision rather than an omission: `V33-DEC-018` refuses a
 * dormant paid state by name, because it is a state machine committed to before
 * #46 and #47 have defined one.
 *
 * The database enforces the same allow-list in a trigger, because a lifecycle
 * upheld only by the service is upheld by the service and by nothing else.
 */
export const SELLER_SUBSCRIPTION_STATES = ['active', 'superseded', 'cancelled'] as const;
export type SellerSubscriptionState = (typeof SELLER_SUBSCRIPTION_STATES)[number];

const PERMITTED_SUBSCRIPTION_TRANSITIONS: Readonly<Record<SellerSubscriptionState, readonly SellerSubscriptionState[]>> = {
  active: ['superseded', 'cancelled'],
  superseded: [],
  cancelled: [],
};

/**
 * Written as an allow-list rather than as a list of refusals, so a fourth state
 * added later is refused by default rather than silently permitted everywhere.
 */
export function isPermittedSubscriptionTransition(
  from: SellerSubscriptionState,
  to: SellerSubscriptionState,
): boolean {
  return (PERMITTED_SUBSCRIPTION_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Where granted credits came from.
 *
 * Only `plan_included` exists in Story #56a. #57 adds the custom-purchase
 * source when top-ups arrive; the database CHECK is widened by that story's own
 * migration rather than left permissive in advance.
 */
export const BOOKING_CREDIT_GRANT_SOURCES = ['plan_included'] as const;
export type BookingCreditGrantSource = (typeof BOOKING_CREDIT_GRANT_SOURCES)[number];

/**
 * The billing period a grant belongs to.
 *
 * Always zero while no publishable plan version carries an approved billing
 * term (`V33-DEC-018`). Named rather than written as a bare `0` at each call
 * site, so the single place recurrence would begin is findable.
 */
export const INITIAL_GRANT_PERIOD_INDEX = 0 as const;
