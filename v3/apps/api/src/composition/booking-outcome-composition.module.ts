import { Global, Module } from '@nestjs/common';

import { BOOKING_RESCHEDULE_OUTCOME_HOOK } from '@beauclick/booking';
import { CommerceModule } from '@beauclick/commerce';
import { PaymentModule } from '@beauclick/payment';

import { BookingOutcomeOrchestrator } from '../outcome/booking-outcome.orchestrator';

/**
 * The booking outcome composition — V3.3 Story #160 (`#42c`), ADR-051 §6.
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
 * It binds exactly one booking token and exports the orchestrator for the
 * `BookingCancelled` consumer; it declares no controller, route or event.
 */
@Global()
@Module({
  imports: [CommerceModule, PaymentModule],
  providers: [
    BookingOutcomeOrchestrator,
    { provide: BOOKING_RESCHEDULE_OUTCOME_HOOK, useExisting: BookingOutcomeOrchestrator },
  ],
  exports: [BookingOutcomeOrchestrator, BOOKING_RESCHEDULE_OUTCOME_HOOK],
})
export class BookingOutcomeCompositionModule {}
