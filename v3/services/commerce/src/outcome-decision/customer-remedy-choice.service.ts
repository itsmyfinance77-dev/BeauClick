import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { returningRows } from '@beauclick/events';

import { CustomerRemedyChoiceOption, CustomerRemedyResolvedBy } from '../entities/customer-remedy-choice.entity';

export interface CustomerRemedyResolution {
  readonly orderId: string;
  readonly bookingId: string;
  readonly chosen: CustomerRemedyChoiceOption | null;
  readonly resolvedBy: CustomerRemedyResolvedBy;
}

const RESOLUTION_COLUMNS = 'order_id, booking_id, chosen, resolved_by';

interface ResolutionRow {
  order_id: string;
  booking_id: string;
  chosen: CustomerRemedyChoiceOption | null;
  resolved_by: CustomerRemedyResolvedBy;
}

function toResolution(row: ResolutionRow): CustomerRemedyResolution {
  return { orderId: row.order_id, bookingId: row.booking_id, chosen: row.chosen, resolvedBy: row.resolved_by };
}

/**
 * The customer's remedy choice after a non-customer cancellation — V3.3 #161
 * (`#42d`), ADR-051 §8, `V33-DEC-039` R7.
 *
 * Owns `commerce.customer_remedy_choices` exactly the way
 * `BookingOutcomeDecisionService` owns `booking_outcome_decisions`: the write
 * side only, every guarantee re-enforced by the database underneath it
 * (`database/migrations/commerce/20260921100003_…`). A row is always offered
 * already resolved to the default (there is no ratified waiting period to
 * model, ADR-051 §8) and moves at most once more, to a customer's explicit
 * `reschedule` choice.
 */
@Injectable()
export class CustomerRemedyChoiceService {
  /**
   * Offers the remedy, already resolved to the default — idempotent on
   * `order_id`: a redelivered cancellation decision (the same event handled
   * twice) writes nothing the second time and changes no existing resolution.
   */
  async offerDefault(manager: EntityManager, orderId: string, bookingId: string): Promise<void> {
    await manager.query(
      `INSERT INTO commerce.customer_remedy_choices (order_id, booking_id, resolved_by, resolved_at)
       VALUES ($1, $2, 'default', now())
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, bookingId],
    );
  }

  /** The current resolution, or `null` if this order was never offered a remedy. */
  async resolution(manager: EntityManager, orderId: string): Promise<CustomerRemedyResolution | null> {
    const rows: ResolutionRow[] = await manager.query(
      `SELECT ${RESOLUTION_COLUMNS} FROM commerce.customer_remedy_choices WHERE order_id = $1`,
      [orderId],
    );
    return rows[0] ? toResolution(rows[0]) : null;
  }

  /**
   * The resolution, locked `FOR UPDATE` for the caller's transaction — the
   * lock the remedy route's own reschedule decision is made under
   * (ADR-051's lock table: "choice row FOR UPDATE -> (reschedule: booking FOR
   * UPDATE -> claim -> move)").
   */
  async lockResolution(manager: EntityManager, orderId: string): Promise<CustomerRemedyResolution | null> {
    const rows: ResolutionRow[] = await manager.query(
      `SELECT ${RESOLUTION_COLUMNS} FROM commerce.customer_remedy_choices WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    return rows[0] ? toResolution(rows[0]) : null;
  }

  /**
   * Records the customer's explicit override to a free reschedule — the one
   * further move this table permits. Returns `false` when the row was
   * already `resolved_by = 'customer'` (a repeated request, idempotent
   * no-op: the caller must not reschedule a second time). The caller is
   * responsible for having already checked, under the SAME lock, that the
   * linked cancellation decision has not yet executed its refund — this
   * method records the choice; it does not gate on payment state, which it
   * has no way to read (`services/commerce` may not import `payment`).
   */
  async resolveReschedule(manager: EntityManager, orderId: string): Promise<boolean> {
    const raw: unknown = await manager.query(
      `UPDATE commerce.customer_remedy_choices
          SET resolved_by = 'customer', chosen = 'reschedule', chosen_at = now(), resolved_at = now()
        WHERE order_id = $1 AND resolved_by = 'default'
        RETURNING order_id`,
      [orderId],
    );
    return returningRows(raw).length === 1;
  }
}
