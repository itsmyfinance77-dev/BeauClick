// Stage: professional verification — the request is opened first, evidence (a
// SYNTHETIC generated image, clearly not a real document) is attached to it, then
// the moderator decides: pro1 approved, the practitioner rejected, pro2 left pending
// in the queue for the live moderation demo.
import { rawRequest } from '../lib/client.mjs';
import { syntheticPng } from '../lib/png.mjs';

const items = (d) => (Array.isArray(d) ? d : d?.items ?? d?.value ?? []);

async function evidenceImage(s) {
  const png = syntheticPng(1000, 700, [[226, 232, 240], [120, 130, 150]], 4);
  const grant = (await s.post('/v1/media/upload-url', { purpose: 'verification_evidence', contentType: 'image/png', byteSize: png.length })).data;
  await rawRequest(new URL(grant.upload.url, s.origin).toString(), { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  await s.post(`/v1/media/${grant.mediaId}/finalize`);
  return grant.mediaId;
}

export const verification = {
  name: 'verification',
  async run({ as, state, log, save }) {
    const v = (state.ids.verification ??= {});
    for (const key of ['pro1', 'pro2', 'bizPractitioner']) {
      if (v[key]) continue;
      const s = await as(key);
      const submitted = await s.post('/v1/verification/submit', { note: 'مدرک نمونهٔ ساختگی برای دمو — سند واقعی نیست.' }, { expect: [200, 201, 409] });
      const mediaId = await evidenceImage(s);
      const attached = await s.post('/v1/verification/evidence', { mediaId }, { expect: [200, 201, 409] });
      const me = await s.get('/v1/verification/me');
      v[key] = { submit: submitted.status, evidence: attached.status, status: me.data?.status ?? me.data?.request?.status };
      save();
      log(`${key}: submit HTTP ${submitted.status}, evidence HTTP ${attached.status}, status ${v[key].status}`);
    }
    const mod = await as('moderator');
    const queue = items((await mod.get('/v1/admin/verification/queue?page=1&limit=20')).data);
    log(`verification queue: ${queue.length} request(s); keys: ${Object.keys(queue[0] ?? {}).join(',')}`);
    const pid = (k) => state.ids[k === 'bizPractitioner' ? 'practitioner' : k].providerId;
    const find = (k) => queue.find((q) => [q.professionalId, q.providerId, q.professional?.id, q.subjectId].includes(pid(k)));
    for (const [k, decision, reason] of [
      ['pro1', 'approve', 'مدارک نمونه بررسی و تأیید شد (سناریوی دمو).'],
      ['bizPractitioner', 'reject', 'تصویر مدرک خوانا نیست؛ لطفاً دوباره بارگذاری کنید (سناریوی دمو).'],
    ]) {
      const req = find(k);
      if (!req || v[`${k}Decided`]) continue;
      await mod.post(`/v1/admin/verification/${req.id}/decide`, { decision, reason });
      v[`${k}Decided`] = decision;
      save();
      log(`moderator ${decision}s ${k}`);
    }
  },
};
