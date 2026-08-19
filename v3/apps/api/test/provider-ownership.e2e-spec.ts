import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, CapturingOtpObserver } from './test-app.factory';
import { assertNoLeak } from '@beauclick/testing';

/**
 * V3_SECURITY_MODEL.md §4's required test shape, applied to provider-
 * service per this task's explicit requirement: "provider isolation:
 * provider A cannot modify provider B." Every test here seeds a REAL
 * second party with a distinguishable value and asserts it never leaks or
 * can be mutated by the first party -- not merely that the request "fails"
 * some way.
 */
describe('Provider ownership isolation (e2e)', () => {
  let app: INestApplication;
  let otpObserver: CapturingOtpObserver;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    otpObserver = testApp.otpObserver;
  });

  afterAll(async () => {
    await app.close();
  });

  async function loginAsNewUser(phone: string): Promise<{ accessToken: string; userId: string }> {
    await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
    const code = otpObserver.lastCodeFor('+98' + phone.slice(1));
    const verify = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
    return { accessToken: verify.body.data.accessToken, userId: verify.body.data.user.id };
  }

  async function createProfessional(accessToken: string, displayName: string, bio: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ displayName, bio });
    expect(res.status).toBeLessThan(300); // POST returns 200 or 201 depending on Nest defaults; either is a success here
    return res.body.data.id;
  }

  it('a client-supplied ownerId in the create payload is rejected outright, not silently accepted or silently stripped', async () => {
    const partyA = await loginAsNewUser('09130000001');
    const partyB = await loginAsNewUser('09130000002');

    // CreateProfessionalDto does not declare an ownerId field, and the
    // global ValidationPipe is forbidNonWhitelisted:true -- an unexpected
    // field is a hard validation error (400), not silently dropped. This
    // is stronger than silent stripping would be: a caller who tries to
    // supply an owner id finds out immediately their request is malformed,
    // rather than getting a confusing silent no-op.
    const res = await request(app.getHttpServer())
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${partyA.accessToken}`)
      .send({ displayName: 'Party A Salon', bio: 'test', ownerId: partyB.userId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    // Confirm no profile was created under either party as a side effect of the rejected request.
    const created = await createProfessional(partyA.accessToken, 'Party A Salon (real)', 'test');
    const updateAsB = await request(app.getHttpServer())
      .patch(`/api/v1/providers/${created}`)
      .set('Authorization', `Bearer ${partyB.accessToken}`)
      .send({ displayName: 'Hijacked' });
    expect(updateAsB.status).toBe(404);
    expect(updateAsB.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
  });

  it('provider A cannot modify provider B -- a forged provider id in the PATCH URL is rejected, not silently scoped', async () => {
    const partyA = await loginAsNewUser('09130000003');
    const partyB = await loginAsNewUser('09130000004');

    const bSecretBio = 'PARTY_B_SECRET_BIO_MARKER_998877';
    const providerBId = await createProfessional(partyB.accessToken, 'Party B Salon', bSecretBio);
    await createProfessional(partyA.accessToken, 'Party A Salon', 'party a bio');

    // Party A attempts to PATCH party B's real, existing provider id.
    const forgedUpdate = await request(app.getHttpServer())
      .patch(`/api/v1/providers/${providerBId}`)
      .set('Authorization', `Bearer ${partyA.accessToken}`)
      .send({ displayName: 'HIJACKED BY A', bio: 'overwritten' });

    expect(forgedUpdate.status).toBe(404);
    expect(forgedUpdate.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
    assertNoLeak(forgedUpdate.body, bSecretBio);

    // Confirm party B's data is genuinely untouched, not just that the request "failed".
    const bAfter = await request(app.getHttpServer()).get(`/api/v1/providers/${providerBId}`);
    expect(bAfter.body.data.displayName).toBe('Party B Salon');
    expect(bAfter.body.data.bio).toBe(bSecretBio);
  });

  it('an update to a nonexistent provider id and an update to someone else\'s real provider id return the IDENTICAL response shape (no existence leak)', async () => {
    const partyA = await loginAsNewUser('09130000005');
    const partyB = await loginAsNewUser('09130000006');
    const providerBId = await createProfessional(partyB.accessToken, 'Party B Salon 2', 'bio');

    const nonexistentId = '01234567-89ab-cdef-0123-456789abcdef'; // well-formed UUID, no row

    const forgedReal = await request(app.getHttpServer())
      .patch(`/api/v1/providers/${providerBId}`)
      .set('Authorization', `Bearer ${partyA.accessToken}`)
      .send({ displayName: 'x' });
    const forgedFake = await request(app.getHttpServer())
      .patch(`/api/v1/providers/${nonexistentId}`)
      .set('Authorization', `Bearer ${partyA.accessToken}`)
      .send({ displayName: 'x' });

    expect(forgedReal.status).toBe(forgedFake.status);
    expect(forgedReal.body).toEqual(forgedFake.body);
  });

  it('unauthorized update is rejected even with a completely unauthenticated request', async () => {
    const partyB = await loginAsNewUser('09130000007');
    const providerBId = await createProfessional(partyB.accessToken, 'Party B Salon 3', 'bio');

    const res = await request(app.getHttpServer()).patch(`/api/v1/providers/${providerBId}`).send({ displayName: 'no token at all' });
    expect(res.status).toBe(401);
  });

  it('a service offering cannot be created under another provider\'s profile', async () => {
    const partyA = await loginAsNewUser('09130000008');
    const partyB = await loginAsNewUser('09130000009');
    const providerBId = await createProfessional(partyB.accessToken, 'Party B Salon 4', 'bio');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/providers/${providerBId}/services`)
      .set('Authorization', `Bearer ${partyA.accessToken}`)
      .send({ name: 'Hijacked Service', durationMinutes: 30, priceToman: 100000 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
  });

  it('one user cannot create a second professional profile for themselves (one profile per identity)', async () => {
    const party = await loginAsNewUser('09130000010');
    await createProfessional(party.accessToken, 'First Profile', 'bio');

    const second = await request(app.getHttpServer())
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${party.accessToken}`)
      .send({ displayName: 'Second Profile', bio: 'bio' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });
});
