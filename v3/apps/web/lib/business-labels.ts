import type { BadgeTone } from '@/components/kit';

/**
 * How the business page names a staff member's role and membership status.
 *
 * Keyed by the server's `BUSINESS_STAFF_ROLES` and `BUSINESS_STAFF_STATUSES`
 * (`business-staff.entity.ts`); `business-labels.spec.ts` reads both and fails
 * on drift in either direction. `removed` was added to the vocabulary late
 * (V3.3 `#109`) and, until a label existed, the badge of an erased member
 * rendered blank — which reads as a broken row rather than a real state. An
 * unknown value now shows a neutral word, so the same thing cannot happen
 * again quietly.
 */
export const STAFF_ROLE_LABEL: Record<string, string> = {
  manager: 'مدیر',
  staff: 'کارمند',
};

export const UNKNOWN_STAFF_ROLE_LABEL = 'عضو';

export function staffRoleLabel(role: string): string {
  return STAFF_ROLE_LABEL[role] ?? UNKNOWN_STAFF_ROLE_LABEL;
}

export const STAFF_STATUS_LABEL: Record<string, string> = {
  invited: 'دعوت‌شده',
  active: 'فعال',
  inactive: 'غیرفعال',
  declined: 'رد شده',
  removed: 'حذف‌شده',
};

export const STAFF_STATUS_TONE: Record<string, BadgeTone> = {
  invited: 'warning',
  active: 'success',
  inactive: 'neutral',
  declined: 'error',
  // Terminal and not an error the owner can act on — the same quiet tone
  // `inactive` carries, for the same reason.
  removed: 'neutral',
};

export const UNKNOWN_STAFF_STATUS_LABEL = 'نامشخص';

export function staffStatusLabel(status: string): string {
  return STAFF_STATUS_LABEL[status] ?? UNKNOWN_STAFF_STATUS_LABEL;
}

export function staffStatusTone(status: string): BadgeTone {
  return STAFF_STATUS_TONE[status] ?? 'neutral';
}
