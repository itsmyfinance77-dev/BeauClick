// Synthetic demo identities. NOT real people and NOT real numbers in use by anyone we
// know of: no SMS ever leaves this machine (the inbox simulator is the only recipient,
// and it refuses every number that is not on this list).
//
// Roles are never written here as grants. Each account is created by the real
// OTP sign-in and acquires authority only through the product's own mechanisms:
// the documented one-time operator bootstrap script, the audited admin role API,
// professional/business self-service, and the business owner's staff invitations
// and finance_read grants.

export const PERSONAS = Object.freeze([
  { key: 'admin', phone: '+989120000101', displayName: 'مدیر سامانه (دمو)', intendedRole: 'administrator' },
  { key: 'operator', phone: '+989120000102', displayName: 'اپراتور سامانه (دمو)', intendedRole: 'platform_operator' },
  { key: 'moderator', phone: '+989120000103', displayName: 'ناظر محتوا (دمو)', intendedRole: 'moderator' },
  { key: 'pro1', phone: '+989120000201', displayName: 'نگار آرایشگر (دمو)', intendedRole: 'professional' },
  { key: 'pro2', phone: '+989120000202', displayName: 'سارا متخصص ناخن (دمو)', intendedRole: 'professional' },
  { key: 'bizOwner', phone: '+989120000301', displayName: 'مالک سالن (دمو)', intendedRole: 'business' },
  { key: 'bizManager', phone: '+989120000302', displayName: 'مدیر شعبه (دمو)', intendedRole: 'staff:manager' },
  { key: 'bizPractitioner', phone: '+989120000303', displayName: 'کارشناس سالن (دمو)', intendedRole: 'staff:practitioner' },
  { key: 'financeReader', phone: '+989120000304', displayName: 'حسابدار (دمو)', intendedRole: 'finance_read grantee' },
  { key: 'cust1', phone: '+989120000401', displayName: 'مریم مشتری (دمو)', intendedRole: 'customer' },
  { key: 'cust2', phone: '+989120000402', displayName: 'زهرا مشتری (دمو)', intendedRole: 'customer' },
  { key: 'cust3', phone: '+989120000403', displayName: 'الهام مشتری (دمو)', intendedRole: 'customer' },
  { key: 'cust4', phone: '+989120000404', displayName: 'نیلوفر مشتری (دمو)', intendedRole: 'customer' },
]);

export const SYNTHETIC_PHONES = Object.freeze(PERSONAS.map((p) => p.phone));

export function persona(key) {
  const p = PERSONAS.find((x) => x.key === key);
  if (!p) throw new Error(`Unknown persona ${key}`);
  return p;
}

/**
 * Inbox member slots. Each team member sees ONLY the codes for the one synthetic
 * account assigned to them; the demo owner sees every code. The owner may rename
 * or re-assign slots before handing credentials out (see demo/README.md).
 */
export const INBOX_MEMBER_SLOTS = Object.freeze([
  { id: 'owner', role: 'owner', personas: [] },
  { id: 'member-admin-1', role: 'member', personas: ['admin'] },
  { id: 'member-moderator-1', role: 'member', personas: ['moderator'] },
  { id: 'member-pro-1', role: 'member', personas: ['pro1'] },
  { id: 'member-business-1', role: 'member', personas: ['bizOwner'] },
  { id: 'member-staff-1', role: 'member', personas: ['bizManager'] },
  { id: 'member-finance-reader-1', role: 'member', personas: ['financeReader'] },
  { id: 'member-customer-1', role: 'member', personas: ['cust1'] },
  { id: 'member-customer-2', role: 'member', personas: ['cust2'] },
]);
