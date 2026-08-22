import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';
import { DomainException } from '@beauclick/http';
import { assertNonNegativeAmount } from '@beauclick/money';

import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import { OrderAdjustmentEntity } from '../entities/order-adjustment.entity';
import { CommerceOutboxEntity } from '../entities/commerce-outbox.entity';
import { PricingService } from '../pricing/pricing.service';
import { PricingResult } from '../pricing/pricing.types';
import { SERVICE_CATALOG, ServiceCatalog } from '../ports';

export class OrderNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export class UnsellableServiceException extends DomainException {
  constructor() {
    super('SERVICE_UNAVAILABLE_FOR_SALE', 'این خدمت در حال حاضر قابل رزرو نیست.', HttpStatus.CONFLICT);
  }
}

export class RefundExceedsOrderException extends DomainException {
  constructor() {
    super('REFUND_EXCEEDS_ORDER', 'مبلغ بازگشتی از مبلغ قابل بازگشت سفارش بیشتر است.', HttpStatus.CONFLICT);
  }
}

export interface CreateBookingOrderInput {
  bookingId: string;
  customerId: string;
  professionalId: string;
  serviceId: string | null;
}

export interface OrderWithDetail {
  order: OrderEntity;
  items: OrderItemEntity[];
  adjustments: OrderAdjustmentEntity[];
}

@Injectable()
export class OrderService {
  private readonly auditLog = new AuditLogger('commerce');

  constructor(
    @InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity) private readonly items: Repository<OrderItemEntity>,
    @InjectRepository(OrderAdjustmentEntity) private readonly adjustments: Repository<OrderAdjustmentEntity>,
    private readonly dataSource: DataSource,
    private readonly pricing: PricingService,
    @Inject(SERVICE_CATALOG) private readonly catalog: ServiceCatalog,
  ) {}

  /**
   * Creates (or returns) THE order for a booking.
   *
   * **Idempotent by database constraint, not by convention.** GAP-03 in V2
   * was that booking->order creation had no idempotency guard and
   * "self-healed only by accident" -- a re-fired hook or a retry could
   * create a second authoritative order and orphan the first. Here,
   * `UNIQUE(source_type, source_id)` makes a second order for the same
   * booking impossible at the storage layer; this method's job is only to
   * turn that impossibility into a friendly "here is the one that exists".
   *
   * Accepts an `EntityManager` so the caller can create the booking and its
   * order in ONE transaction. That is the deliberate consistency choice:
   * both live in the same PostgreSQL cluster, so a real ACID transaction is
   * available and there is no reason to accept an eventually-consistent
   * "booking exists but has no order" window that every reader would then
   * have to defend against.
   */
  async createForBooking(input: CreateBookingOrderInput, manager?: EntityManager): Promise<OrderWithDetail> {
    const existing = await this.findBySource('booking', input.bookingId, manager);
    if (existing) return existing;

    try {
      return await this.runInTransaction(manager, (m) => this.createForBookingWithin(m, input));
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent request won. Its order is the authoritative one.
        const settled = await this.findBySource('booking', input.bookingId);
        if (settled) return settled;
      }
      throw err;
    }
  }

  private async createForBookingWithin(
    manager: EntityManager,
    input: CreateBookingOrderInput,
  ): Promise<OrderWithDetail> {
    if (!input.serviceId) throw new UnsellableServiceException();

    // The price comes from the catalogue, server-side, every time. A client
    // never supplies, influences, or even sees a price field on the way in.
    const offering = await this.catalog.findServiceOffering(input.serviceId);
    if (!offering || offering.professionalId !== input.professionalId) {
      throw new UnsellableServiceException();
    }

    const priced: PricingResult = await this.pricing.quote({
      customerId: input.customerId,
      sellerPartyType: offering.sellerPartyType,
      sellerPartyId: offering.sellerPartyId,
      bookingId: input.bookingId,
      at: new Date(),
      lines: [
        {
          referenceId: offering.id,
          name: offering.name,
          quantity: 1,
          unitPriceToman: offering.priceToman,
        },
      ],
    });

    const orderId = uuidv7();
    await manager.insert(OrderEntity, {
      id: orderId,
      sourceType: 'booking',
      sourceId: input.bookingId,
      customerId: input.customerId,
      sellerPartyType: offering.sellerPartyType,
      sellerPartyId: offering.sellerPartyId,
      status: 'pending',
      currency: priced.currency,
      subtotalToman: priced.subtotalToman,
      discountTotalToman: priced.discountTotalToman,
      feeTotalToman: priced.feeTotalToman,
      totalToman: priced.totalToman,
      refundedTotalToman: 0,
      paidAt: null,
      cancelledAt: null,
    });

    await manager.insert(OrderItemEntity, {
      id: uuidv7(),
      orderId,
      itemType: 'service',
      referenceId: offering.id,
      name: offering.name,
      quantity: 1,
      unitPriceToman: offering.priceToman,
      lineTotalToman: offering.priceToman,
    });

    if (priced.adjustments.length > 0) {
      await manager.insert(
        OrderAdjustmentEntity,
        priced.adjustments.map((adjustment, index) => ({
          id: uuidv7(),
          orderId,
          ruleKey: adjustment.ruleKey,
          kind: adjustment.kind,
          code: adjustment.code,
          label: adjustment.label,
          amountToman: adjustment.amountToman,
          sortOrder: index,
        })),
      );
    }

    await emitEvent(manager, CommerceOutboxEntity, {
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'OrderCreated',
      payload: {
        orderId,
        sourceType: 'booking',
        sourceId: input.bookingId,
        customerId: input.customerId,
        sellerPartyType: offering.sellerPartyType,
        sellerPartyId: offering.sellerPartyId,
        subtotalToman: priced.subtotalToman,
        totalToman: priced.totalToman,
        currency: priced.currency,
      },
    });

    this.auditLog.log({ action: 'order.created', orderId, bookingId: input.bookingId, total: priced.totalToman });
    return this.loadDetail(manager, orderId);
  }

  /**
   * pending -> paid. Called by the payment verification path, inside the
   * same transaction that records the verified payment.
   *
   * Compare-and-swap on `status = 'pending'`, so a replayed gateway callback
   * finds zero rows and returns false rather than re-emitting `OrderPaid`
   * and double-recording a commission downstream.
   */
  async markPaid(orderId: string, manager: EntityManager): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(OrderEntity)
      .set({ status: 'paid', paidAt: new Date() })
      .where('id = :orderId AND status = :pending', { orderId, pending: 'pending' satisfies OrderStatus })
      .execute();

    if (result.affected !== 1) return false;

    const order = await manager.findOneOrFail(OrderEntity, { where: { id: orderId } });
    await emitEvent(manager, CommerceOutboxEntity, {
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'OrderPaid',
      payload: {
        orderId,
        sourceType: order.sourceType,
        sourceId: order.sourceId,
        customerId: order.customerId,
        sellerPartyType: order.sellerPartyType,
        sellerPartyId: order.sellerPartyId,
        totalToman: order.totalToman,
        currency: order.currency,
        paidAt: (order.paidAt ?? new Date()).toISOString(),
      },
    });

    this.auditLog.log({ action: 'order.paid', orderId, total: order.totalToman });
    return true;
  }

  /** pending -> cancelled. An unpaid order only; a paid one goes through refund instead. */
  async cancel(orderId: string, reason: string, manager?: EntityManager): Promise<boolean> {
    return this.runInTransaction(manager, async (m) => {
      const result = await m
        .createQueryBuilder()
        .update(OrderEntity)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where('id = :orderId AND status = :pending', { orderId, pending: 'pending' satisfies OrderStatus })
        .execute();

      if (result.affected !== 1) return false;

      await emitEvent(m, CommerceOutboxEntity, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'OrderCancelled',
        payload: { orderId, cancelledAt: new Date().toISOString(), reason },
      });
      return true;
    });
  }

  /**
   * Records a completed refund against the order.
   *
   * Never rewrites history: `refundedTotalToman` only ever increases, and
   * the original `totalToman` is left exactly as charged. The status becomes
   * `partially_refunded` or `refunded` depending on whether the cumulative
   * refunded amount has reached the total.
   *
   * The `refunded_total + :amount <= total` predicate is in the UPDATE's own
   * WHERE clause, not a preceding read: that is what makes two concurrent
   * refunds unable to over-refund an order between each other's check and
   * write.
   */
  async recordRefund(
    orderId: string,
    amountToman: number,
    refundId: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    assertNonNegativeAmount(amountToman, 'refund amount');
    if (amountToman === 0) return false;
    return this.runInTransaction(manager, (m) => this.recordRefundWithin(m, orderId, amountToman, refundId));
  }

  private async recordRefundWithin(
    manager: EntityManager,
    orderId: string,
    amountToman: number,
    refundId: string,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(OrderEntity)
      // Raw SQL expressions, so the increment is computed BY THE DATABASE
      // from the row's current value rather than from a value this process
      // read a moment ago -- read-modify-write in application code is
      // exactly how two concurrent refunds each overwrite the other's
      // increment. `amountToman` has already passed assertNonNegativeAmount,
      // so it is a validated integer and safe to inline (TypeORM does not
      // parameterize a function-valued `set`).
      .set({
        refundedTotalToman: () => `refunded_total_toman + ${amountToman}`,
        status: () =>
          `CASE WHEN refunded_total_toman + ${amountToman} >= total_toman THEN 'refunded' ELSE 'partially_refunded' END`,
      })
      .where(
        'id = :orderId AND status IN (:...refundable) AND refunded_total_toman + :amount <= total_toman',
        { orderId, refundable: ['paid', 'partially_refunded'] satisfies OrderStatus[], amount: amountToman },
      )
      .execute();

    if (result.affected !== 1) {
      const order = await manager.findOne(OrderEntity, { where: { id: orderId } });
      if (!order) throw new OrderNotFoundException();
      if (order.refundedTotalToman + amountToman > order.totalToman) throw new RefundExceedsOrderException();
      return false;
    }

    const order = await manager.findOneOrFail(OrderEntity, { where: { id: orderId } });
    await emitEvent(manager, CommerceOutboxEntity, {
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'OrderRefunded',
      payload: {
        orderId,
        refundId,
        refundAmountToman: amountToman,
        refundedTotalToman: order.refundedTotalToman,
        currency: order.currency,
        refundedAt: new Date().toISOString(),
      },
    });

    this.auditLog.log({ action: 'order.refunded', orderId, refundId, amountToman });
    return true;
  }

  /** What is still refundable on this order right now. Always recomputed, never cached -- V2's proven discipline. */
  remainingRefundable(order: OrderEntity): number {
    return Math.max(0, order.totalToman - order.refundedTotalToman);
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async findById(orderId: string, manager?: EntityManager): Promise<OrderEntity | null> {
    const repo = manager ? manager.getRepository(OrderEntity) : this.orders;
    return repo.findOne({ where: { id: orderId } });
  }

  async findBySource(
    sourceType: 'booking' | 'direct',
    sourceId: string,
    manager?: EntityManager,
  ): Promise<OrderWithDetail | null> {
    const repo = manager ? manager.getRepository(OrderEntity) : this.orders;
    const order = await repo.findOne({ where: { sourceType, sourceId } });
    if (!order) return null;
    return this.loadDetail(manager ?? this.dataSource.manager, order.id);
  }

  async detailFor(orderId: string): Promise<OrderWithDetail | null> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) return null;
    return this.loadDetail(this.dataSource.manager, orderId);
  }

  async listForCustomer(customerId: string, page: number, limit: number): Promise<{ items: OrderEntity[]; total: number }> {
    const [items, total] = await this.orders.findAndCount({
      where: { customerId },
      order: { id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }

  private async loadDetail(manager: EntityManager, orderId: string): Promise<OrderWithDetail> {
    const order = await manager.findOneOrFail(OrderEntity, { where: { id: orderId } });
    // Two bounded queries by order id, never a per-order loop -- an order
    // list page must not become an N+1 (a bug class this project has already
    // found and fixed several times in V2).
    const [items, adjustments] = await Promise.all([
      manager.find(OrderItemEntity, { where: { orderId }, order: { id: 'ASC' } }),
      manager.find(OrderAdjustmentEntity, { where: { orderId }, order: { sortOrder: 'ASC' } }),
    ]);
    return { order, items, adjustments };
  }

  private runInTransaction<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return manager ? fn(manager) : this.dataSource.transaction(fn);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
