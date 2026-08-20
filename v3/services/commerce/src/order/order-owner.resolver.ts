import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OwnerResolver } from '@beauclick/ownership';
import { OrderEntity } from '../entities/order.entity';

/**
 * An order belongs to the customer who owes the money.
 *
 * The professional deliberately gets no read access to the order document
 * itself in Phase 2: what they legitimately need is what they EARN, which is
 * financial-service's receivable view -- a different question, answered by a
 * different module, with its own party-isolation rules. Exposing the whole
 * order here "because the professional is involved" would hand the seller a
 * customer-scoped record for no product reason.
 */
@Injectable()
export class OrderOwnerResolver implements OwnerResolver<{ id: string }> {
  constructor(@InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>) {}

  async resolve(_sessionUserId: string, params: { id: string }): Promise<string | null> {
    const order = await this.orders.findOne({ where: { id: params.id } });
    return order?.customerId ?? null;
  }
}
