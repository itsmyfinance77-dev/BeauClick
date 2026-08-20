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
  customer: ['bc_book_service', 'bc_use_ai_assistant', 'bc_view_own_orders'],
  professional: [
    'bc_manage_own_profile',
    'bc_manage_own_services',
    'bc_view_own_bookings',
    // Phase 2: a professional manages their own availability and reads their
    // own earnings. Both surfaces derive the party from the session, so these
    // capabilities gate the ACTION, never a party the caller names.
    'bc_manage_own_availability',
    'bc_view_own_finance',
  ],
  business: [
    'bc_manage_own_profile',
    'bc_manage_own_services',
    'bc_view_own_bookings',
    'bc_manage_business_staff',
    'bc_manage_own_availability',
    'bc_view_own_finance',
  ],
  moderator: ['bc_moderate_verification', 'bc_moderate_reviews'],
  // V3_SECURITY_MODEL.md §9: a narrower tier below full administrator that
  // V2 built but never actually used for a real account -- V3 should
  // default new privileged accounts to this, not full admin.
  platform_operator: ['bc_manage_platform'],
  administrator: ['bc_manage_platform', 'bc_moderate_verification', 'bc_moderate_reviews', 'bc_manage_own_profile'],
};

export function capabilitiesForRoles(roles: string[]): string[] {
  const set = new Set<string>();
  for (const role of roles) {
    const caps = CAPABILITIES_BY_ROLE[role as Role];
    if (caps) caps.forEach((c) => set.add(c));
  }
  return Array.from(set);
}
