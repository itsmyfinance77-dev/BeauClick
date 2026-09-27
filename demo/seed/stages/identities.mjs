// Stage: identities and platform roles.
//  - every persona signs in once through the real OTP flow (the account is created
//    by the product's own resolveOrCreate path, as a customer);
//  - platform_operator, then administrator, through the documented one-time
//    bootstrap (administrator needs --force by design; the reason is recorded in the
//    admin audit log);
//  - the administrator appoints the moderator through the audited role API
//    (administrator is never grantable through the API — the product's own rule).
import { persona } from '../personas.mjs';

const REASON = 'Synthetic demo account for the internal team demo 2026-09-28, approved by the owner on 2026-09-27';

export const identities = {
  name: 'identities',
  async run({ as, refreshed, bootstrapPrivileged, state, log }) {
    for (const p of (await import('../personas.mjs')).PERSONAS) {
      const s = await as(p.key);
      state.ids[`user:${p.key}`] = s.userId;
      log(`${p.key}: signed in (roles: ${s.roles.join(',') || '-'})`);
    }

    const operatorRoles = (await as('operator')).roles;
    if (!operatorRoles.includes('platform_operator')) {
      log(bootstrapPrivileged(persona('operator').phone, 'platform_operator', REASON));
    }
    const adminRoles = (await as('admin')).roles;
    if (!adminRoles.includes('administrator')) {
      log(bootstrapPrivileged(persona('admin').phone, 'administrator', REASON));
    }
    const admin = await refreshed('admin');
    await refreshed('operator');
    log(`admin roles after bootstrap: ${admin.roles.join(',')}`);

    const mod = await as('moderator');
    if (!mod.roles.includes('moderator')) {
      await admin.post(`/v1/admin/users/${mod.userId}/roles`, { roleSlug: 'moderator', operation: 'grant', reason: REASON });
    }
    const modNow = await refreshed('moderator');
    log(`moderator roles: ${modNow.roles.join(',')}`);
    if (!modNow.roles.includes('moderator')) throw new Error('moderator grant did not take effect');

    // Denied-path evidence recorded during seeding: an operator may NOT appoint a
    // moderator (subset rule), and nobody may grant administrator through the API.
    const operator = await as('operator');
    const opTry = await operator.post(`/v1/admin/users/${(await as('cust4')).userId}/roles`, { roleSlug: 'moderator', operation: 'grant', reason: 'denied-path probe' }, { expect: [400, 403, 409, 422] });
    const adminTry = await admin.post(`/v1/admin/users/${(await as('cust4')).userId}/roles`, { roleSlug: 'administrator', operation: 'grant', reason: 'denied-path probe' }, { expect: [400, 403, 409, 422] });
    state.evidence = { ...(state.evidence ?? {}), operatorGrantsModerator: opTry.status, adminGrantsAdministratorViaApi: adminTry.status };
    log(`denied paths: operator->moderator HTTP ${opTry.status}; administrator via API HTTP ${adminTry.status}`);
  },
};
