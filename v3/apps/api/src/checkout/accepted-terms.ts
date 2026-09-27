/**
 * DEMO BRANCH ONLY (DEMO-DEC-001, part A) — never merged to master.
 *
 * `GET /v1/bookings/:id/accepted-terms`: the cancellation / no-show terms the
 * customer ACCEPTED for this booking, read back from the order's own snapshot
 * (`commerce.order_outcome_terms`, written in the booking transaction only when
 * the acceptance matched the disclosed versions) together with the text of
 * exactly the accepted copy version — even if that version has since been
 * retired, because the customer accepted THAT text.
 *
 * Read-only. Owner-scoped by the booking's customer (anyone else gets the
 * non-enumerating 404 the ownership guard gives). An unenrolled booking answers
 * `{ governed: false }` — terms are never fabricated for it.
 */
import { Controller, Get, Injectable, Param } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ResolveOwner } from '@beauclick/ownership';
import { BookingCustomerResolver } from '@beauclick/booking';

type Retention =
  | { kind: 'none' }
  | { kind: 'full_collected' }
  | { kind: 'percentage_of_collected'; basisPoints: number }
  | { kind: 'fixed_toman'; amountToman: number };

export type AcceptedTermsView =
  | { governed: false }
  | {
      governed: true;
      acceptedAt: string;
      policy: { policyKey: string; policyVersion: number };
      copy: { copyKey: string; copyVersion: number; locale: string | null; body: string | null; bodySha256: string | null };
      terms: {
        cutoffHours: number;
        cutoffInstant: string;
        lateCancellationRetention: Retention;
        noShowGraceMinutes: number;
        noShowRetention: Retention;
        rescheduleFreeCountBeforeCutoff: number;
        disputeWindowHours: number;
        bodilyHarmWindowHours: number | null;
        appealWindowHours: number;
      };
    };

function retention(kind: string, bp: number | null, amount: string | null): Retention {
  if (kind === 'percentage_of_collected') return { kind, basisPoints: Number(bp) };
  if (kind === 'fixed_toman') return { kind, amountToman: Number(amount) };
  if (kind === 'full_collected') return { kind };
  return { kind: 'none' };
}

@Injectable()
export class AcceptedTermsService {
  constructor(private readonly dataSource: DataSource) {}

  async forBooking(bookingId: string): Promise<AcceptedTermsView> {
    const rows = await this.dataSource.query(
      `SELECT t.*, b.slot_start
         FROM commerce.orders o
         JOIN commerce.order_outcome_terms t ON t.order_id = o.id
         JOIN booking.bookings b ON b.id = o.source_id
        WHERE o.source_type = 'booking' AND o.source_id = $1
        ORDER BY o.created_at DESC
        LIMIT 1`,
      [bookingId],
    );
    const t = rows[0];
    if (!t) return { governed: false };

    // Draft text is never shown as accepted text; published-then-retired is.
    const copyRows = await this.dataSource.query(
      `SELECT locale, body, body_sha256
         FROM commercial.customer_policy_copy_versions
        WHERE copy_key = $1 AND version = $2 AND lifecycle_state IN ('published', 'retired')`,
      [t.copy_key, t.copy_version],
    );
    const c = copyRows[0] ?? null;
    const slotStart = new Date(t.slot_start);
    return {
      governed: true,
      acceptedAt: new Date(t.resolved_at).toISOString(),
      policy: { policyKey: t.policy_key, policyVersion: Number(t.policy_version) },
      copy: {
        copyKey: t.copy_key,
        copyVersion: Number(t.copy_version),
        locale: c?.locale ?? null,
        body: c?.body ?? null,
        bodySha256: c?.body_sha256 ?? null,
      },
      terms: {
        cutoffHours: Number(t.cutoff_hours),
        cutoffInstant: new Date(slotStart.getTime() - Number(t.cutoff_hours) * 3_600_000).toISOString(),
        lateCancellationRetention: retention(t.late_retention_kind, t.late_retention_basis_points, t.late_retention_amount_toman),
        noShowGraceMinutes: Number(t.grace_minutes),
        noShowRetention: retention(t.no_show_retention_kind, t.no_show_retention_basis_points, t.no_show_retention_amount_toman),
        rescheduleFreeCountBeforeCutoff: Number(t.reschedule_free_count),
        disputeWindowHours: Number(t.dispute_window_hours),
        bodilyHarmWindowHours: t.bodily_harm_window_hours === null ? null : Number(t.bodily_harm_window_hours),
        appealWindowHours: Number(t.appeal_window_hours),
      },
    };
  }
}

@Controller('v1')
export class AcceptedTermsController {
  constructor(private readonly terms: AcceptedTermsService) {}

  @ResolveOwner(BookingCustomerResolver)
  @Get('bookings/:id/accepted-terms')
  async acceptedTerms(@Param('id') id: string): Promise<AcceptedTermsView> {
    return this.terms.forBooking(id);
  }
}
