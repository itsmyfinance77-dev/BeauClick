import type { ApiClient } from './api-client';

/**
 * Typed wrappers for Phase 4's surfaces (Business/Seller, Waitlist).
 * Same discipline as phase3-api.ts: every type here is the PUBLIC response
 * shape the controller actually returns, not an internal document.
 */

// --------------------------------------------------------------- business

export type BusinessStaffRole = 'manager' | 'staff';
export type BusinessStaffStatus = 'invited' | 'active' | 'inactive' | 'declined';

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

export function inviteStaff(
  api: ApiClient,
  businessId: string,
  input: { userId: string; professionalId?: string; role: BusinessStaffRole },
) {
  return api.post<BusinessStaffMember>(`/v1/businesses/${businessId}/staff`, input);
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
