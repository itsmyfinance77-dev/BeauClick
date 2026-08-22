/**
 * waitlist-service's outbound port for "who owns this professional profile?"
 *
 * Same shape as booking-service's `ProfessionalDirectory` (ADR-011 forbids
 * one `services/*` package importing another, so waitlist-service cannot
 * import booking-service's port even though the answer is identical) --
 * the composition root binds its existing `ProviderBackedProfessionalDirectory`
 * to this token too, rather than a second implementation answering the same
 * question a second way.
 */
export interface ProfessionalOwnerLookup {
  ownerUserIdFor(professionalId: string): Promise<string | null>;
}

export const PROFESSIONAL_OWNER_LOOKUP = Symbol('BEAUCLICK_WAITLIST_PROFESSIONAL_OWNER_LOOKUP');
