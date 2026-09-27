/**
 * DEMO BRANCH ONLY (DEMO-DEC-001 part B) — never merged to master.
 *
 * A durable replacement offer after a provider-side cancellation, independent of
 * the default refund (which continues untouched). See the decision record for the
 * state machine and the money analysis; in short:
 *
 *  - created in the cancellation decision's own transaction (same condition that
 *    offers #212's default remedy), idempotent on the original booking;
 *  - `open` until dismissed or until ONE replacement booking confirms; no expiry;
 *  - a replacement is always a NEW booking with its own order, payment and
 *    freshly accepted terms, at the current price — never a fund transfer;
 *  - at most one attempt may be `pending` at a time; a declined / cancelled /
 *    lapsed attempt never consumes the offer;
 *  - `used` is DERIVED from the truth (a linked booking with `confirmed_at`), and
 *    persisted under the offer lock whenever it is observed. A capture after a
 *    lapsed hold never confirms (existing checkout auto-refunds), so with the
 *    single-pending rule at most one attempt can ever confirm.
 *
 * Lock order for an attempt: offer row FOR UPDATE, THEN the existing checkout's
 * slot/booking/order. The payment callback never touches the offer row, so no
 * lock cycle exists with it.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DomainException } from '@beauclick/http';

export class ReplacementOfferNotFoundException extends DomainException {
  constructor() {
    super('REPLACEMENT_OFFER_NOT_FOUND', 'برای این رزرو پیشنهاد جایگزینی وجود ندارد.', HttpStatus.NOT_FOUND);
  }
}
export class ReplacementOfferNotOpenException extends DomainException {
  constructor(public readonly offerStatus: string) {
    super(
      'REPLACEMENT_OFFER_NOT_OPEN',
      offerStatus === 'used' ? 'از این پیشنهاد جایگزینی قبلاً استفاده شده است.' : 'این پیشنهاد جایگزینی دیگر فعال نیست.',
      HttpStatus.CONFLICT,
    );
  }
}
export class ReplacementAttemptInProgressException extends DomainException {
  constructor() {
    super(
      'REPLACEMENT_ATTEMPT_IN_PROGRESS',
      'یک رزرو جایگزین در انتظار پرداخت است. آن را پرداخت یا لغو کنید، یا تا پایان مهلت نگه‌داری آن صبر کنید.',
      HttpStatus.CONFLICT,
    );
  }
}
export class ReplacementNotAvailableException extends DomainException {
  constructor() {
    super('REPLACEMENT_NOT_AVAILABLE', 'این خدمت یا متخصص در حال حاضر فعال نیست؛ بازپرداخت شما ادامه دارد.', HttpStatus.CONFLICT);
  }
}
export class ReplacementSlotNotEligibleException extends DomainException {
  constructor() {
    super('REPLACEMENT_SLOT_NOT_ELIGIBLE', 'این زمان برای همان خدمت و همان متخصص نیست.', HttpStatus.CONFLICT);
  }
}

interface OfferRow {
  original_booking_id: string;
  original_order_id: string;
  customer_id: string;
  professional_id: string;
  service_id: string;
  offered_at: Date;
  status: 'open' | 'used' | 'dismissed';
  resolved_at: Date | null;
  replacement_booking_id: string | null;
}

export interface ReplacementOfferView {
  status: 'open' | 'used' | 'dismissed';
  offeredAt: string;
  resolvedAt: string | null;
  professionalId: string;
  serviceId: string;
  service: { name: string | null; currentPriceToman: number | null; durationMinutes: number | null; active: boolean };
  provider: { displayName: string | null; active: boolean };
  eligible: boolean;
  ineligibleReason: null | 'service_inactive' | 'provider_inactive';
  activeAttempt: null | { bookingId: string; orderId: string | null; holdExpiresAt: string | null };
  replacementBookingId: string | null;
  originalRefund: null | { executionStatus: string; refundToman: string };
}

export interface ReplacementCheckoutHooks {
  /** Runs FIRST inside the checkout transaction: the offer lock and every guard. */
  lock(manager: EntityManager): Promise<void>;
  /** Runs after the booking row exists, in the same transaction. */
  link(manager: EntityManager, bookingId: string): Promise<void>;
}

@Injectable()
export class ReplacementOfferService {
  constructor(private readonly dataSource: DataSource) {}

  /** Called inside `decideCancellation`'s transaction for provider-side causes. */
  async offerOnCancellation(manager: EntityManager, orderId: string, bookingId: string): Promise<void> {
    await manager.query(
      `INSERT INTO commerce.replacement_offers (original_booking_id, original_order_id, customer_id, professional_id, service_id)
       SELECT b.id, $2, b.customer_id, b.professional_id, b.service_id
         FROM booking.bookings b
        WHERE b.id = $1 AND b.service_id IS NOT NULL
       ON CONFLICT (original_booking_id) DO NOTHING`,
      [bookingId, orderId],
    );
  }

  private async lockOffer(m: EntityManager, bookingId: string): Promise<OfferRow> {
    const rows: OfferRow[] = await m.query(`SELECT * FROM commerce.replacement_offers WHERE original_booking_id = $1 FOR UPDATE`, [bookingId]);
    if (!rows[0]) throw new ReplacementOfferNotFoundException();
    return rows[0];
  }

  /** Persists `used` if a linked booking has confirmed. Caller holds the offer lock. */
  private async settleUsed(m: EntityManager, offer: OfferRow): Promise<OfferRow> {
    if (offer.status !== 'open') return offer;
    const confirmed = await m.query(
      `SELECT a.booking_id FROM commerce.replacement_offer_attempts a
         JOIN booking.bookings b ON b.id = a.booking_id
        WHERE a.original_booking_id = $1 AND b.confirmed_at IS NOT NULL
        ORDER BY b.confirmed_at LIMIT 1`,
      [offer.original_booking_id],
    );
    if (!confirmed[0]) return offer;
    await m.query(
      `UPDATE commerce.replacement_offers SET status = 'used', replacement_booking_id = $2, resolved_at = now()
        WHERE original_booking_id = $1 AND status = 'open'`,
      [offer.original_booking_id, confirmed[0].booking_id],
    );
    return { ...offer, status: 'used', replacement_booking_id: confirmed[0].booking_id, resolved_at: new Date() };
  }

  private async pendingAttempt(m: EntityManager, originalBookingId: string) {
    const rows = await m.query(
      `SELECT a.booking_id, a.idempotency_key, b.hold_expires_at,
              (SELECT o.id FROM commerce.orders o WHERE o.source_type = 'booking' AND o.source_id = a.booking_id LIMIT 1) AS order_id
         FROM commerce.replacement_offer_attempts a
         JOIN booking.bookings b ON b.id = a.booking_id
        WHERE a.original_booking_id = $1 AND b.status = 'pending'
        ORDER BY a.created_at DESC LIMIT 1`,
      [originalBookingId],
    );
    return rows[0] ?? null;
  }

  private async eligibility(m: EntityManager, offer: OfferRow) {
    const [svc] = await m.query(`SELECT name, price_toman, duration_minutes, deleted_at FROM provider.services WHERE id = $1`, [offer.service_id]);
    const [pro] = await m.query(`SELECT display_name, deleted_at FROM provider.professionals WHERE id = $1`, [offer.professional_id]);
    const serviceActive = Boolean(svc) && svc.deleted_at === null;
    const providerActive = Boolean(pro) && pro.deleted_at === null;
    return {
      svc,
      pro,
      serviceActive,
      providerActive,
      reason: !providerActive ? ('provider_inactive' as const) : !serviceActive ? ('service_inactive' as const) : null,
    };
  }

  async view(bookingId: string): Promise<ReplacementOfferView> {
    return this.dataSource.transaction(async (m) => {
      const offer = await this.settleUsed(m, await this.lockOffer(m, bookingId));
      const el = await this.eligibility(m, offer);
      const pending = await this.pendingAttempt(m, bookingId);
      const [refund] = await m.query(
        `SELECT execution_status, refund_toman::text AS refund_toman FROM commerce.booking_outcome_decisions
          WHERE booking_id = $1 AND decision_kind = 'cancellation' AND superseded_by_id IS NULL
          ORDER BY decided_at DESC LIMIT 1`,
        [bookingId],
      );
      return {
        status: offer.status,
        offeredAt: new Date(offer.offered_at).toISOString(),
        resolvedAt: offer.resolved_at ? new Date(offer.resolved_at).toISOString() : null,
        professionalId: offer.professional_id,
        serviceId: offer.service_id,
        service: {
          name: el.svc?.name ?? null,
          currentPriceToman: el.svc ? Number(el.svc.price_toman) : null,
          durationMinutes: el.svc ? Number(el.svc.duration_minutes) : null,
          active: el.serviceActive,
        },
        provider: { displayName: el.pro?.display_name ?? null, active: el.providerActive },
        eligible: offer.status === 'open' && el.reason === null,
        ineligibleReason: el.reason,
        activeAttempt:
          offer.status === 'open' && pending
            ? {
                bookingId: pending.booking_id,
                orderId: pending.order_id ?? null,
                holdExpiresAt: pending.hold_expires_at ? new Date(pending.hold_expires_at).toISOString() : null,
              }
            : null,
        replacementBookingId: offer.replacement_booking_id,
        originalRefund: refund ? { executionStatus: refund.execution_status, refundToman: refund.refund_toman } : null,
      };
    });
  }

  async dismiss(bookingId: string): Promise<{ status: 'dismissed' | 'used' }> {
    return this.dataSource.transaction(async (m) => {
      const offer = await this.settleUsed(m, await this.lockOffer(m, bookingId));
      if (offer.status === 'dismissed') return { status: 'dismissed' as const }; // idempotent
      if (offer.status !== 'open') throw new ReplacementOfferNotOpenException(offer.status);
      if (await this.pendingAttempt(m, bookingId)) throw new ReplacementAttemptInProgressException();
      await m.query(
        `UPDATE commerce.replacement_offers SET status = 'dismissed', resolved_at = now() WHERE original_booking_id = $1 AND status = 'open'`,
        [bookingId],
      );
      return { status: 'dismissed' as const };
    });
  }

  /** The guards and the link, run inside the checkout's own transaction (lock order: offer first). */
  checkoutHooks(bookingId: string, idempotencyKey: string, slotId: string): ReplacementCheckoutHooks & { serviceId: () => string; professionalId: () => string } {
    let offer: OfferRow | null = null;
    return {
      serviceId: () => {
        if (!offer) throw new Error('replacement hooks used before lock');
        return offer.service_id;
      },
      professionalId: () => {
        if (!offer) throw new Error('replacement hooks used before lock');
        return offer.professional_id;
      },
      lock: async (m) => {
        const locked = await this.settleUsed(m, await this.lockOffer(m, bookingId));
        if (locked.status !== 'open') throw new ReplacementOfferNotOpenException(locked.status);
        const pending = await this.pendingAttempt(m, bookingId);
        // A replay of the SAME attempt (same key) proceeds and converges on its booking.
        if (pending && pending.idempotency_key !== idempotencyKey) throw new ReplacementAttemptInProgressException();
        const el = await this.eligibility(m, locked);
        if (el.reason) throw new ReplacementNotAvailableException();
        const [slot] = await m.query(`SELECT professional_id, service_id FROM booking.availability_slots WHERE id = $1`, [slotId]);
        if (!slot || slot.professional_id !== locked.professional_id || (slot.service_id !== null && slot.service_id !== locked.service_id)) {
          throw new ReplacementSlotNotEligibleException();
        }
        offer = locked;
      },
      link: async (m, newBookingId) => {
        await m.query(
          `INSERT INTO commerce.replacement_offer_attempts (booking_id, original_booking_id, idempotency_key)
           VALUES ($1, $2, $3) ON CONFLICT (booking_id) DO NOTHING`,
          [newBookingId, bookingId, idempotencyKey],
        );
      },
    };
  }
}
