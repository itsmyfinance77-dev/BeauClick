import { Controller, Get, Param, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { NotFoundOrNotYoursException, ResolveOwner } from '@beauclick/ownership';

import { OrderService, OrderWithDetail } from './order.service';
import { OrderOwnerResolver } from './order-owner.resolver';
import { OrderEntity } from '../entities/order.entity';

function toOrderSummary(order: OrderEntity) {
  return {
    id: order.id,
    sourceType: order.sourceType,
    sourceId: order.sourceId,
    status: order.status,
    currency: order.currency,
    subtotalToman: order.subtotalToman,
    discountTotalToman: order.discountTotalToman,
    feeTotalToman: order.feeTotalToman,
    totalToman: order.totalToman,
    refundedTotalToman: order.refundedTotalToman,
    paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * The receipt shape.
 *
 * Every adjustment is listed individually rather than folded into a single
 * "discount" figure -- a customer must be able to see WHY the price is what
 * it is, and these rows are exactly what the pricing engine produced at
 * order time, not a recomputation against today's rules.
 */
export function toOrderDetail(detail: OrderWithDetail) {
  return {
    ...toOrderSummary(detail.order),
    items: detail.items.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unitPriceToman: i.unitPriceToman,
      lineTotalToman: i.lineTotalToman,
    })),
    adjustments: detail.adjustments.map((a) => ({
      ruleKey: a.ruleKey,
      kind: a.kind,
      code: a.code,
      label: a.label,
      amountToman: a.amountToman,
    })),
  };
}

@Controller('v1')
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Get('me/orders')
  async myOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<PaginatedResult<ReturnType<typeof toOrderSummary>[]>> {
    const { items, total } = await this.orders.listForCustomer(user.userId, query.page, query.limit);
    return { value: items.map(toOrderSummary), meta: { pagination: { page: query.page, limit: query.limit, total } } };
  }

  @ResolveOwner(OrderOwnerResolver)
  @Get('orders/:id')
  async getOne(@Param('id') id: string) {
    const detail = await this.orders.detailFor(id);
    if (!detail) throw new NotFoundOrNotYoursException();
    return toOrderDetail(detail);
  }
}
