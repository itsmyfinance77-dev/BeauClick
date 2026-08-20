import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilitySlotEntity } from './entities/availability-slot.entity';
import { BookingEntity } from './entities/booking.entity';
import { BookingHistoryEntity } from './entities/booking-history.entity';
import { BookingIdempotencyKeyEntity } from './entities/booking-idempotency-key.entity';
import { BookingOutboxEntity } from './entities/booking-outbox.entity';

import { BookingConfig } from './booking.config';
import { AvailabilityService } from './availability/availability.service';
import { BookingService } from './booking/booking.service';
import { BookingPartyResolver, BookingProfessionalResolver } from './booking/booking-party.resolver';
import { BookingController } from './booking/booking.controller';
import { MyAvailabilityController, PublicAvailabilityController } from './availability/availability.controller';

export const BOOKING_ENTITIES = [
  AvailabilitySlotEntity,
  BookingEntity,
  BookingHistoryEntity,
  BookingIdempotencyKeyEntity,
  BookingOutboxEntity,
];

/**
 * Note what this module does NOT provide: an implementation of
 * `PROFESSIONAL_DIRECTORY`. That port is declared by booking-service and
 * supplied by the composition root, so this module is unusable without a
 * deliberate wiring decision -- which is the point. A default in-module
 * implementation would either import provider-service (forbidden) or
 * fabricate an answer to an authorization question (far worse).
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(BOOKING_ENTITIES)],
  controllers: [BookingController, PublicAvailabilityController, MyAvailabilityController],
  providers: [BookingConfig, AvailabilityService, BookingService, BookingPartyResolver, BookingProfessionalResolver],
  exports: [BookingService, AvailabilityService, BookingConfig, BookingPartyResolver, TypeOrmModule],
})
export class BookingModule {}
