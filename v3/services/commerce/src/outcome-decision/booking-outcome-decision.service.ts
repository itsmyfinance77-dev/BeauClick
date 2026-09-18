import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { returningRows } from '@beauclick/events';

import {
  BookingOutcomeBasis,
  BookingOutcomeCause,
  BookingOutcomeDecisionKind,
  BookingOutcomeRetentionRule,
  LegalCapState,
  bookingOutcomeRetentionRuleFromColumns,
} from '@beauclick/commercial-policy-contract';

import { OrderStatus } from '../entities/order.entity';
import { LEGAL_EVIDENCE_STATE_READER, LegalEvidenceStateReader } from '../ports';

/** The booking's order, held `FOR UPDATE` by the deciding transaction. */
export interface LockedBookingOrder {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly collectedTotalToman: bigint;
  readonly refundedTotalToman: bigint;
}

/**
 * The part of an order's accepted outcome terms a decision reads, plus the
 * Legal cap's state at this instant. `null` from `termsFor` is the fail-closed
 * fact: the order carries no terms (`legacy_unenrolled`).
 *
 * `noShowGraceMinutes`, `noShowRetention` and `disputeWindowHours` were added
 * by V3.3 #161 (`#42d`), ADR-051 §7 — additive fields on an already-published
 * shape, read the same way every other member here is.
 */
export interface OrderDecisionTerms {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly cutoffHours: number;
  readonly rescheduleFreeCount: number;
  readonly lateCancellationRetention: BookingOutcomeRetentionRule;
  readonly noShowGraceMinutes: number;
  readonly noShowRetention: BookingOutcomeRetentionRule;
  readonly disputeWindowHours: number;
  readonly legalCap: BookingOutcomeRetentionRule | null;
  readonly legalCapState: LegalCapState;
}

export type BookingOutcomeExecutionStatus = 'pending' | 'executed' | 'manual_required' | 'failed';

/** One decision as it is written. Instants are PostgreSQL text, never a JavaScript `Date`. */
export interface NewBookingOutcomeDecision {
  readonly bookingId: string;
  readonly orderId: string;
  readonly kind: BookingOutcomeDecisionKind;
  readonly cause: BookingOutcomeCause;
  /** The database-clock instant of the cancelling or rescheduling transaction, as PostgreSQL text. */
  readonly eventInstant: string;
  readonly bookingWasConfirmed: boolean;
  readonly policyKey: string | null;
  readonly policyVersion: number | null;
  readonly cutoffInstant: string | null;
  readonly timely: boolean | null;
  readonly collectedRemainingToman: bigint;
  readonly policyAmountToman: bigint;
  readonly legalCapToman: bigint | null;
  readonly legalCapState: LegalCapState;
  readonly retainedToman: bigint;
  readonly refundToman: bigint;
  readonly basis: BookingOutcomeBasis;
  readonly executionStatus: BookingOutcomeExecutionStatus;
  readonly refundRequestKey: string | null;
}

export interface BookingOutcomeDecisionRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly orderId: string;
  readonly kind: BookingOutcomeDecisionKind;
  readonly retainedToman: bigint;
  readonly refundToman: bigint;
  readonly basis: BookingOutcomeBasis;
  readonly executionStatus: BookingOutcomeExecutionStatus;
  readonly refundRequestKey: string | null;
}

const DECISION_COLUMNS = `id, booking_id, order_id, decision_kind, retained_toman::text AS retained_toman,
  refund_toman::text AS refund_toman, basis, execution_status, refund_request_key`;

interface DecisionRow {
  id: string;
  booking_id: string;
  order_id: string;
  decision_kind: BookingOutcomeDecisionKind;
  retained_toman: string;
  refund_toman: string;
  basis: BookingOutcomeBasis;
  execution_status: BookingOutcomeExecutionStatus;
  refund_request_key: string | null;
}

/**
 * Commerce's record of booking outcome decisions — V3.3 Story #160 (`#42c`),
 * ADR-051 §6.
 *
 * Commerce owns the table because a decision is about the money an order
 * collected. It does NOT evaluate: the pure evaluator lives in Commercial
 * Policy, which `scope:commerce` may not import, and the composition root
 * joins the two. What this service guarantees is the write side — the lock,
 * the snapshot read, one live decision per booking and kind, and the
 * forward-only execution record — every one of which the database enforces
 * again underneath it (`20260920100001_create_booking_outcome_decisions.sql`).
 *
 * Every read and write takes the caller's `manager`, so a decision can never
 * be written on a connection outside the transaction that locked its order.
 */
@Injectable()
export class BookingOutcomeDecisionService {
  constructor(
    private readonly dataSource: DataSource,
    /**
     * Mandatory, deliberately without `@Optional()`: a missing binding would
     * make every cap silently unreadable, and "unreadable" must never be
     * something a composition can be in by accident.
     */
    @Inject(LEGAL_EVIDENCE_STATE_READER) private readonly legalEvidence: LegalEvidenceStateReader,
  ) {}

  /**
   * The booking's order, locked `FOR UPDATE` — the FIRST lock of every decision
   * (ADR-050 §4.2/§7: order row before booking row). `null` when the booking
   * has no order.
   */
  async lockOrderForBooking(manager: EntityManager, bookingId: string): Promise<LockedBookingOrder | null> {
    const rows: Array<{ id: string; status: OrderStatus; collected: string; refunded: string }> = await manager.query(
      `SELECT id, status, collected_total_toman::text AS collected, refunded_total_toman::text AS refunded
         FROM commerce.orders
        WHERE source_type = 'booking' AND source_id = $1
        FOR UPDATE`,
      [bookingId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      orderId: row.id,
      status: row.status,
      collectedTotalToman: BigInt(row.collected),
      refundedTotalToman: BigInt(row.refunded),
    };
  }

  /**
   * Whether the booking's order carries outcome terms, WITHOUT any lock.
   *
   * Terms are immutable and never acquired after creation (ADR-051 invariant
   * 7), so this answer cannot change — which is what lets a reschedule decide
   * whether to take the order lock at all before it takes any lock.
   */
  async bookingHasOutcomeTerms(manager: EntityManager, bookingId: string): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `SELECT 1
         FROM commerce.orders o
         JOIN commerce.order_outcome_terms t ON t.order_id = o.id
        WHERE o.source_type = 'booking' AND o.source_id = $1`,
      [bookingId],
    );
    return rows.length > 0;
  }

  /** The order's accepted terms and the Legal cap's state right now, or `null` (`legacy_unenrolled`). */
  async termsFor(manager: EntityManager, orderId: string): Promise<OrderDecisionTerms | null> {
    const rows: Array<{
      policy_key: string;
      policy_version: number;
      cutoff_hours: number;
      reschedule_free_count: number;
      late_retention_kind: string;
      late_retention_basis_points: number | null;
      late_retention_amount_toman: string | null;
      grace_minutes: number;
      no_show_retention_kind: string;
      no_show_retention_basis_points: number | null;
      no_show_retention_amount_toman: string | null;
      dispute_window_hours: number;
      legal_cap_kind: string | null;
      legal_cap_basis_points: number | null;
      legal_cap_amount_toman: string | null;
      legal_evidence_id: string | null;
    }> = await manager.query(
      `SELECT policy_key, policy_version, cutoff_hours, reschedule_free_count,
              late_retention_kind, late_retention_basis_points, late_retention_amount_toman::text AS late_retention_amount_toman,
              grace_minutes, no_show_retention_kind, no_show_retention_basis_points,
              no_show_retention_amount_toman::text AS no_show_retention_amount_toman, dispute_window_hours,
              legal_cap_kind, legal_cap_basis_points, legal_cap_amount_toman::text AS legal_cap_amount_toman,
              legal_evidence_id
         FROM commerce.order_outcome_terms
        WHERE order_id = $1`,
      [orderId],
    );
    const row = rows[0];
    if (!row) return null;

    const legalCap =
      row.legal_cap_kind === null
        ? null
        : bookingOutcomeRetentionRuleFromColumns(row.legal_cap_kind, row.legal_cap_basis_points, row.legal_cap_amount_toman);
    const legalCapState: LegalCapState =
      legalCap === null ? 'absent' : await this.legalEvidence.capStateFor(manager, row.legal_evidence_id);

    return {
      policyKey: row.policy_key,
      policyVersion: Number(row.policy_version),
      cutoffHours: Number(row.cutoff_hours),
      rescheduleFreeCount: Number(row.reschedule_free_count),
      lateCancellationRetention: bookingOutcomeRetentionRuleFromColumns(
        row.late_retention_kind,
        row.late_retention_basis_points,
        row.late_retention_amount_toman,
      ),
      noShowGraceMinutes: Number(row.grace_minutes),
      noShowRetention: bookingOutcomeRetentionRuleFromColumns(
        row.no_show_retention_kind,
        row.no_show_retention_basis_points,
        row.no_show_retention_amount_toman,
      ),
      disputeWindowHours: Number(row.dispute_window_hours),
      legalCap,
      legalCapState,
    };
  }

  /**
   * The order id for a booking, WITHOUT any lock — V3.3 #161 (`#42d`).
   *
   * Mirrors `bookingHasOutcomeTerms`'s reasoning: an order's `(source_type,
   * source_id)` never changes after creation, so this answer cannot go stale
   * between an unlocked read and a later, separately-locked write. Used to
   * resolve a booking's remedy-choice row by its order id without taking the
   * order lock a no-show or remedy-choice READ does not need.
   */
  async orderIdForBooking(manager: EntityManager, bookingId: string): Promise<string | null> {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT id FROM commerce.orders WHERE source_type = 'booking' AND source_id = $1`,
      [bookingId],
    );
    return rows[0]?.id ?? null;
  }

  /** The live decision of this kind for this booking, if one exists. */
  async liveDecision(
    manager: EntityManager,
    bookingId: string,
    kind: BookingOutcomeDecisionKind,
  ): Promise<BookingOutcomeDecisionRecord | null> {
    const rows: DecisionRow[] = await manager.query(
      `SELECT ${DECISION_COLUMNS}
         FROM commerce.booking_outcome_decisions
        WHERE booking_id = $1 AND decision_kind = $2 AND superseded_by_id IS NULL`,
      [bookingId, kind],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Writes a decision, or returns the live one a concurrent writer already
   * committed. The partial unique index is the linearization point: a
   * duplicate `ON CONFLICT` inserts nothing and the existing row is returned,
   * so two deliveries of one event can never produce two decisions.
   */
  async recordDecision(manager: EntityManager, decision: NewBookingOutcomeDecision): Promise<BookingOutcomeDecisionRecord> {
    const rows = returningRows<DecisionRow>(
      await manager.query(
        `${INSERT_DECISION}
         ON CONFLICT (booking_id, decision_kind) WHERE superseded_by_id IS NULL DO NOTHING
         RETURNING ${DECISION_COLUMNS}`,
        insertParameters(uuidv7(), decision),
      ),
    );
    if (rows[0]) return toRecord(rows[0]);
    const live = await this.liveDecision(manager, decision.bookingId, decision.kind);
    if (!live) throw new Error('booking outcome decision conflict without a live decision');
    return live;
  }

  /**
   * Writes the next decision of a kind that is replaced rather than repeated
   * (a reschedule consequence), superseding the live one in the same
   * transaction. The superseded row points at the new id first; the deferred
   * foreign key and the deferred shape trigger check both at commit.
   */
  async recordSupersedingDecision(manager: EntityManager, decision: NewBookingOutcomeDecision): Promise<BookingOutcomeDecisionRecord> {
    const id = uuidv7();
    await manager.query(
      `UPDATE commerce.booking_outcome_decisions
          SET superseded_by_id = $1
        WHERE booking_id = $2 AND decision_kind = $3 AND superseded_by_id IS NULL`,
      [id, decision.bookingId, decision.kind],
    );
    const rows = returningRows<DecisionRow>(
      await manager.query(`${INSERT_DECISION} RETURNING ${DECISION_COLUMNS}`, insertParameters(id, decision)),
    );
    return toRecord(rows[0]);
  }

  /**
   * Records how the refund executing a decision ended: one compare-and-swap
   * from `pending`, in its own short transaction. `false` when the row had
   * already moved (a redelivery recording the same outcome again).
   */
  async recordExecution(decisionId: string, status: Exclude<BookingOutcomeExecutionStatus, 'pending'>): Promise<boolean> {
    const raw: unknown = await this.dataSource.query(
      `UPDATE commerce.booking_outcome_decisions
          SET execution_status = $2
        WHERE id = $1 AND execution_status = 'pending'
        RETURNING id`,
      [decisionId, status],
    );
    return returningRows(raw).length === 1;
  }
}

const INSERT_DECISION = `INSERT INTO commerce.booking_outcome_decisions
  (id, booking_id, order_id, decision_kind, cause, event_instant, booking_was_confirmed,
   policy_key, policy_version, cutoff_instant, timely,
   collected_remaining_toman, policy_amount_toman, legal_cap_toman, legal_cap_state,
   retained_toman, refund_toman, basis, execution_status, refund_request_key)
  VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::timestamptz, $11,
          $12::bigint, $13::bigint, $14::bigint, $15, $16::bigint, $17::bigint, $18, $19, $20)`;

function insertParameters(id: string, d: NewBookingOutcomeDecision): unknown[] {
  return [
    id,
    d.bookingId,
    d.orderId,
    d.kind,
    d.cause,
    d.eventInstant,
    d.bookingWasConfirmed,
    d.policyKey,
    d.policyVersion,
    d.cutoffInstant,
    d.timely,
    d.collectedRemainingToman.toString(),
    d.policyAmountToman.toString(),
    d.legalCapToman === null ? null : d.legalCapToman.toString(),
    d.legalCapState,
    d.retainedToman.toString(),
    d.refundToman.toString(),
    d.basis,
    d.executionStatus,
    d.refundRequestKey,
  ];
}

function toRecord(row: DecisionRow): BookingOutcomeDecisionRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    orderId: row.order_id,
    kind: row.decision_kind,
    retainedToman: BigInt(row.retained_toman),
    refundToman: BigInt(row.refund_toman),
    basis: row.basis,
    executionStatus: row.execution_status,
    refundRequestKey: row.refund_request_key,
  };
}
