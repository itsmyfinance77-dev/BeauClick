import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilitySlotEntity } from './entities/availability-slot.entity';
import { BookingEntity } from './entities/booking.entity';
import { BookingHistoryEntity } from './entities/booking-history.entity';
import { BookingIdempotencyKeyEntity } from './entities/booking-idempotency-key.entity';
import { BookingOutboxEntity } from './entities/booking-outbox.entity';
import { BookingResourceAssignmentEntity } from './entities/booking-resource-assignment.entity';
import { NoShowDeclarationEntity } from './entities/no-show-declaration.entity';

import { BookingConfig } from './booking.config';
import { AvailabilityService } from './availability/availability.service';
import { BookingService } from './booking/booking.service';
import { BookingCustomerResolver, BookingPartyResolver, BookingProfessionalResolver } from './booking/booking-party.resolver';
import { BookingController } from './booking/booking.controller';
import { MyAvailabilityController, PublicAvailabilityController } from './availability/availability.controller';
import { BookingSubjectDataContract } from './booking-subject-data.contract';

export const BOOKING_ENTITIES = [
  AvailabilitySlotEntity,
  BookingEntity,
  BookingHistoryEntity,
  BookingIdempotencyKeyEntity,
  BookingOutboxEntity,
  // V3.3 Story #128 (`#110b`). Registered here and nowhere else: the
  // composition root spreads this list onto the main DataSource, so a new
  // booking table cannot be reachable at runtime while being invisible to
  // the ORM.
  BookingResourceAssignmentEntity,
  // V3.3 #161 (`#42d`), ADR-051 §7. Registered here and nowhere else, for the
  // same reason `BookingResourceAssignmentEntity` above is.
  NoShowDeclarationEntity,
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
  providers: [
    BookingSubjectDataContract,BookingConfig, AvailabilityService, BookingService, BookingPartyResolver, BookingProfessionalResolver,
    // V3.3 #161 (`#42d`), ADR-051 §8. Used by `apps/api`'s remedy route via `ModuleRef` (`@ResolveOwner`, non-strict).
    BookingCustomerResolver],
  exports: [
    BookingSubjectDataContract,BookingService, AvailabilityService, BookingConfig, BookingPartyResolver, TypeOrmModule,
    BookingCustomerResolver],
})
export class BookingModule {}
