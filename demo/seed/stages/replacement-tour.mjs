// Stage (DEMO-DEC-001 B): an OPEN replacement offer for the presenter's customer (cust1),
// produced the real way — cust1 books pro1 (governed, accepted terms, sandbox payment),
// pro1 cancels, the default refund executes, and the offer waits to be used live.
import { checkout, publicSlots, tehranDate, tehranDay, tehranHour } from '../lib/booking-flow.mjs';

export const replacementTour = {
  name: 'replacement-tour',
  async run({ as, state, log, save }) {
    const r = (state.ids.replacementTour ??= {});
    const { pro1 } = state.ids;
    const cust1 = await as('cust1');
    if (!r.original) {
      const slots = await publicSlots(cust1, pro1.providerId, pro1.serviceIds.party);
      const slot = slots.find((x) => tehranDay(x.startAt) === tehranDate(5) && tehranHour(x.startAt) >= 18);
      const booked = await checkout(cust1, { professionalId: pro1.providerId, serviceId: pro1.serviceIds.party, slotId: slot.id, governed: true });
      r.original = booked.bookingId;
      save();
      log(`cust1 booked pro1 (${booked.resultLocation?.includes('succeeded') ? 'paid' : booked.resultLocation})`);
    }
    if (!r.cancelled) {
      await (await as('pro1')).post(`/v1/bookings/${r.original}/cancel`, { reason: 'بیماری ناگهانی متخصص (سناریوی تور دمو)' });
      r.cancelled = true;
      save();
      log('pro1 cancelled it');
    }
    for (let n = 0; n < 40; n++) {
      const o = await cust1.get(`/v1/bookings/${r.original}/replacement-offer`, { expect: [200, 404] });
      if (o.status === 200) {
        log(`offer: ${o.data.status}; original refund ${o.data.originalRefund?.executionStatus}`);
        return;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('offer did not appear');
  },
};
