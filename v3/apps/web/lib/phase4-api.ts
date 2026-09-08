import type { ApiClient } from './api-client';

/**
 * Typed wrappers for Phase 4's surfaces (Business/Seller, Waitlist).
 * Same discipline as phase3-api.ts: every type here is the PUBLIC response
 * shape the controller actually returns, not an internal document.
 */

// --------------------------------------------------------------- business

export type BusinessStaffRole = 'manager' | 'staff';
/**
 * The membership status vocabulary, mirroring the server's
 * `BUSINESS_STAFF_STATUSES`.
 *
 * `removed` arrived with V3.3 Story #109 (`#44c`): privacy erasure had always
 * written it while neither the type system nor the database knew it, and #109
 * reconciled the vocabulary and closed the column with a CHECK. Omitting it here
 * is what made an erased member render a blank label.
 */
export type BusinessStaffStatus = 'invited' | 'active' | 'inactive' | 'declined' | 'removed';

export interface Business {
  id: string;
  ownerId: string;
  displayName: string;
  bio: string | null;
  cityId: string | null;
  verificationStatus: string;
  createdAt: string;
}

export interface BusinessStaffMember {
  id: string;
  businessId: string;
  userId: string;
  professionalId: string | null;
  role: BusinessStaffRole;
  status: BusinessStaffStatus;
  invitedBy: string;
  respondedAt: string | null;
  createdAt: string;
}

export function myBusiness(api: ApiClient) {
  return api.get<Business | null>('/v1/me/business');
}

export function createBusiness(api: ApiClient, input: { displayName: string; bio?: string; cityId?: string }) {
  return api.post<Business>('/v1/businesses', input);
}

export function getBusiness(api: ApiClient, businessId: string) {
  return api.get<Business>(`/v1/businesses/${businessId}`);
}

export function updateBusiness(api: ApiClient, businessId: string, input: { displayName?: string; bio?: string }) {
  return api.patch<Business>(`/v1/businesses/${businessId}`, input);
}

export function listBusinessStaff(api: ApiClient, businessId: string) {
  return api.get<BusinessStaffMember[]>(`/v1/businesses/${businessId}/staff`);
}

/**
 * What a staff invitation returns, and the reason it is a type of its own.
 *
 * V3.3 Story #109 (`#44c`), `V33-DEC-033` R3/R4. The route answers `202` with an
 * empty object for **every** well-formed outcome -- known, unknown, self,
 * duplicate, already-affiliated-elsewhere, deleted -- so the response carries no
 * membership id, no user id, no professional id, no phone echo and no
 * existence, eligibility or notification state. That is the whole point: the
 * previous contract returned the membership row on success and two distinct
 * `409`s otherwise, which let an owner submit an identity and read back whether
 * it existed.
 *
 * `Record<string, never>` is chosen over `void`, `unknown` or the old
 * `BusinessStaffMember` deliberately. It says "an object with no properties", so
 * a future caller that reaches for `.id` fails to compile rather than reading
 * `undefined` at runtime and quietly reintroducing the oracle. Casting the empty
 * body back into the row type would be the same defect with the compiler
 * silenced.
 */
export type StaffInvitationAccepted = Record<string, never>;

/**
 * Invite a colleague by phone number.
 *
 * The input is exactly `{ phone, role }` -- `role` is the MEMBERSHIP vocabulary
 * `manager | staff`, unrelated to #109's scoped grants. There is deliberately no
 * `userId` and no `professionalId`: the identity and the professional link are
 * resolved server-side from the invited account's own profile, so the inviter
 * neither supplies nor learns them, and no parallel UUID contract survives to be
 * enumerated (`V33-DEC-033` R4).
 *
 * The route path is unchanged; only its request and response changed.
 */
export function inviteStaff(
  api: ApiClient,
  businessId: string,
  input: { phone: string; role: BusinessStaffRole },
) {
  return api.post<StaffInvitationAccepted>(`/v1/businesses/${businessId}/staff`, input);
}

export function removeStaff(api: ApiClient, businessId: string, staffId: string) {
  return api.post<{ removed: boolean }>(`/v1/businesses/${businessId}/staff/${staffId}/remove`);
}

export function myBusinessMemberships(api: ApiClient) {
  return api.get<BusinessStaffMember[]>('/v1/me/business-staff');
}

export function acceptStaffInvite(api: ApiClient, staffId: string) {
  return api.post<BusinessStaffMember>(`/v1/me/business-staff/${staffId}/accept`);
}

export function declineStaffInvite(api: ApiClient, staffId: string) {
  return api.post<{ declined: boolean }>(`/v1/me/business-staff/${staffId}/decline`);
}

export function leaveBusinessStaff(api: ApiClient, staffId: string) {
  return api.post<{ left: boolean }>(`/v1/me/business-staff/${staffId}/leave`);
}

// --------------------------------------------------------------- waitlist

export type WaitlistStatus = 'waiting' | 'offered' | 'accepted' | 'declined' | 'expired' | 'missed' | 'removed';

export interface WaitlistEntry {
  id: string;
  customerId: string;
  professionalId: string;
  serviceId: string | null;
  status: WaitlistStatus;
  offeredSlotId: string | null;
  offerExpiresAt: string | null;
  resultingBookingId: string | null;
  createdAt: string;
}

export function joinWaitlist(api: ApiClient, input: { professionalId: string; serviceId?: string }) {
  return api.post<WaitlistEntry>('/v1/waitlist', input);
}

export function myWaitlistEntries(api: ApiClient) {
  return api.get<WaitlistEntry[]>('/v1/me/waitlist');
}

export function acceptWaitlistOffer(api: ApiClient, entryId: string) {
  return api.post<{ id: string; status: string }>(`/v1/waitlist/${entryId}/accept`);
}

export function declineWaitlistOffer(api: ApiClient, entryId: string) {
  return api.post<WaitlistEntry>(`/v1/waitlist/${entryId}/decline`);
}

export function removeWaitlistEntry(api: ApiClient, entryId: string) {
  return api.post<{ removed: boolean }>(`/v1/waitlist/${entryId}/remove`);
}
