/**
 * V3_SECURITY_MODEL.md §9: prefer capabilities over role-string checks
 * everywhere. Phase 1 foundation deliberately keeps the role->capability
 * MAPPING in code rather than building the dynamic identity.roles /
 * identity.capabilities tables from V3_DATABASE_BLUEPRINT.md §8 (a real,
 * disclosed simplification -- see V3_PHASE1_IMPLEMENTATION.md Known
 * Limitations) -- but every authorization check still goes through
 * capability names, never a role string, so upgrading to dynamic
 * roles/capabilities later changes only where this map's data comes from,
 * not how any guard/controller checks it.
 */
export const ROLES = ['customer', 'professional', 'business', 'moderator', 'platform_operator', 'administrator'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES_BY_ROLE: Record<Role, string[]> = {
  // V3.2-B adds `bc_use_chat`: either legitimate participant may initiate
  // (`V32-DEC-011`), so both sides of a conversation hold it.
  customer: ['bc_book_service', 'bc_use_ai_assistant', 'bc_view_own_orders', 'bc_use_chat'],
  professional: [
    'bc_manage_own_profile',
    'bc_manage_own_services',
    'bc_view_own_bookings',
    // Phase 2: a professional manages their own availability and reads their
    // own earnings. Both surfaces derive the party from the session, so these
    // capabilities gate the ACTION, never a party the caller names.
    'bc_manage_own_availability',
    'bc_view_own_finance',
    // V3.2-B. A professional replying to their own customer is the ordinary
    // case. The capability gates the ACTION; which conversations they may
    // actually reach is decided per request by the seller-access port, never by
    // a role grant.
    'bc_use_chat',
    // V3.3-A Story #69 (`#56b`). Changing one's OWN commercial terms: selecting
    // a published plan version, or cancelling back to the base workspace.
    //
    // Deliberately NOT added to `PRIVILEGED_CAPABILITIES` (`V33-DEC-019`). It
    // confers authority over the holder's own subscription and over nobody
    // else's, so it earns neither the per-request live re-check nor
    // `libs/audit`'s boot-time audit assertion — and the consequence is stated
    // rather than glossed: a revoked grant takes effect at the next token
    // issue, up to the access-token TTL later.
    //
    // Holding it is necessary and never sufficient. WHICH workspace it may act
    // on is decided per request by the ownership resolver, which does not
    // follow staff affiliation — so a capability check that passed would still
    // find no owned party to act on.
    'bc_manage_own_subscription',
  ],
  business: [
    'bc_manage_own_profile',
    'bc_manage_own_services',
    'bc_view_own_bookings',
    'bc_manage_business_staff',
    'bc_manage_own_availability',
    'bc_view_own_finance',
    // V3.2-B. The capability gates the ACTION -- "may this account use chat at
    // all" -- and says nothing about WHICH conversations. Which ones is decided
    // per request by the seller-access port: the business owner and active
    // managers, and nobody else (`V32-DEC-010`).
    //
    // An earlier draft withheld this, reasoning that business access is
    // membership rather than a role. That conflated two different questions and
    // was simply wrong: the capability guard runs first, so a business owner was
    // refused at the door and their membership was never consulted.
    'bc_use_chat',
    // V3.3-A Story #69 (`#56b`). The same capability the professional role
    // above carries, for the same reason: `V33-DEC-018` gives each owned PARTY
    // its own subscription, and a business owner manages theirs exactly as a
    // professional owner manages theirs.
    //
    // A user owning both holds it once and acts on two workspaces, each named
    // explicitly by its own `workspaceRef` — never on both at once, and never
    // on one chosen for them.
    'bc_manage_own_subscription',
  ],
  // `bc_moderate_media` (V3.1 Phase C) sits with the other content-moderation
  // capabilities and deliberately NOT with platform_operator's -- the roles
  // migration records the reasoning: removing somebody's published work is
  // content moderation, not operational administration.
  moderator: ['bc_moderate_verification', 'bc_moderate_reviews', 'bc_moderate_media', 'bc_moderate_chat'],
  // V3_SECURITY_MODEL.md §9: a narrower tier below full administrator that
  // V2 built but never actually used for a real account -- V3 should
  // default new privileged accounts to this, not full admin.
  platform_operator: ['bc_manage_platform'],
  administrator: [
    'bc_manage_platform',
    'bc_moderate_verification',
    'bc_moderate_reviews',
    'bc_moderate_media',
    // V3.2-B. Deliberately NOT granted to `platform_operator`: that tier exists
    // to be the narrower one, and reading a customer's private messages is not
    // platform operation.
    'bc_moderate_chat',
    // V3.3-A Story #40 (`#40a`). Deliberately NOT granted to
    // `platform_operator`: that tier exists to be the narrower one, and
    // publishing an immutable, activation-windowed commitment about what
    // sellers pay is not routine platform operation. The same call, for the
    // same reason, that `bc_moderate_chat` above records.
    'bc_manage_commercial_plans',
    'bc_manage_own_profile',
  ],
};

export function capabilitiesForRoles(roles: string[]): string[] {
  const set = new Set<string>();
  for (const role of roles) {
    const caps = CAPABILITIES_BY_ROLE[role as Role];
    if (caps) caps.forEach((c) => set.add(c));
  }
  return Array.from(set);
}
