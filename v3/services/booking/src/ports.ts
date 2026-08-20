/**
 * booking-service's outbound ports.
 *
 * ADR-011 forbids one `services/*` package importing another, so
 * booking-service cannot call provider-service to answer "which user owns
 * this professional profile?" -- yet it genuinely needs that answer to
 * authorize a professional acting on a booking.
 *
 * The resolution is a port declared HERE and implemented in `apps/api`
 * (`scope:app`, the one tier permitted to compose domains). booking-service
 * depends on an interface it owns; the composition root supplies the
 * provider-backed adapter. Tests supply a fake. No module boundary is
 * crossed and no ownership decision is delegated to a caller.
 */
export interface ProfessionalDirectory {
  /** The identity user id that owns this professional profile, or null if there is no such profile. */
  ownerUserIdFor(professionalId: string): Promise<string | null>;

  /** The professional profile this user owns, or null if they have none. */
  professionalIdForOwner(userId: string): Promise<string | null>;
}

export const PROFESSIONAL_DIRECTORY = Symbol('BEAUCLICK_PROFESSIONAL_DIRECTORY');
