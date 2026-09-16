import { Global, Module } from '@nestjs/common';

import { BOOKING_RESCHEDULE_OUTCOME_HOOK, BookingModule } from '@beauclick/booking';
import { CommerceModule } from '@beauclick/commerce';
import { PaymentModule } from '@beauclick/payment';

import { BookingOutcomeOrchestrator } from '../outcome/booking-outcome.orchestrator';
import { CustomerRemedyResolutionService } from '../outcome/customer-remedy-resolution.service';
import { BookingRemedyController } from '../outcome/booking-remedy.controller';

/**
 * The booking outcome composition — V3.3 Story #160 (`#42c`), ADR-051 §6.
 * Extended by #161 (`#42d`), ADR-051 §7–§8, with the no-show governance
 * method on the SAME hook and the customer-remedy route.
 *
 * ## Why a module of its own, and why `@Global()`
 *
 * `BookingService` must receive `BOOKING_RESCHEDULE_OUTCOME_HOOK` at
 * construction (it is mandatory), and the hook's implementation needs Commerce
 * and Payment. `DomainPortsModule` cannot import `CommerceModule`: Commerce's own
 * services resolve ports that `DomainPortsModule` provides, so the import would
 * be a cycle. This module imports Commerce and Payment — neither of which
 * depends on it or on Booking — and exposes the one token globally, so
 * `BookingModule` resolves it without importing anything.
 *
 * `BookingModule` joined the imports in #161, for `CustomerRemedyResolutionService`
 * alone (it needs `BookingService` to perform the remedy's reschedule) --
 * a one-way edge: `BookingModule` still imports nothing from here.
 *
 * It binds one booking token and exports the orchestrator for the
 * `BookingCancelled` consumer, and declares the one route #161 adds
 * (`POST bookings/:id/remedy`) -- the composition root's own controller,
 * for the reason `CheckoutController` is: the route needs both domains.
 */
@Global()
@Module({
  imports: [CommerceModule, PaymentModule, BookingModule],
  controllers: [BookingRemedyController],
  providers: [
    BookingOutcomeOrchestrator,
    { provide: BOOKING_RESCHEDULE_OUTCOME_HOOK, useExisting: BookingOutcomeOrchestrator },
    CustomerRemedyResolutionService,
  ],
  exports: [BookingOutcomeOrchestrator, BOOKING_RESCHEDULE_OUTCOME_HOOK, CustomerRemedyResolutionService],
})
export class BookingOutcomeCompositionModule {}
