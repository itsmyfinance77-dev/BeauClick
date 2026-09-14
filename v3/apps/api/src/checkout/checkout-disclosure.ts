import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { DataSource } from 'typeorm';

import { policy } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { AvailabilityService, CreateBookingDto } from '@beauclick/booking';
import { OrderService, UnsellableServiceException } from '@beauclick/commerce';
import { BookingOutcomePolicyResolutionService } from '@beauclick/commercial-policy';
import {
  BOOKING_OUTCOME_DISPLAY_TIME_ZONE,
  BOOKING_OUTCOME_KEY_PATTERN,
  BookingOutcomeDisclosureV1,
  acceptanceFor,
} from '@beauclick/commercial-policy-contract';
import {
  FINANCE_WORKSPACE_LABEL_RESOLVER,
  FinanceWorkspaceLabelResolver,
  financePartyKey,
} from '@beauclick/financial';

const MAX_VERSION = 2_147_483_647;

/**
 * The customer's explicit acceptance on the checkout command — V3.3 #159
 * (`#42b`), ADR-051 §4. Exactly the four identifiers the disclosure returned;
 * no instant (the database supplies it), no text, no device or network fact.
 */
export class AcceptedPolicyDto {
  @IsString()
  @Matches(BOOKING_OUTCOME_KEY_PATTERN)
  policyKey!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VERSION)
  policyVersion!: number;

  @IsString()
  @Matches(BOOKING_OUTCOME_KEY_PATTERN)
  copyKey!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VERSION)
  copyVersion!: number;
}

/**
 * `POST /v1/bookings`'s body: booking's own DTO plus the optional acceptance.
 *
 * Extended here in `apps/api`, where the checkout spans booking and commerce,
 * so booking's `CreateBookingDto` stays byte-identical. A request without
 * `acceptedPolicy` is exactly today's request; any other unknown field is
 * still a 400 under `forbidNonWhitelisted`.
 */
export class CreateCheckoutDto extends CreateBookingDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AcceptedPolicyDto)
  acceptedPolicy?: AcceptedPolicyDto;
}

/** The disclosure query, and nothing else. Unknown query fields are a 400. */
export class CheckoutDisclosureQueryDto {
  @IsUUID()
  professionalId!: string;

  @IsUUID()
  slotId!: string;

  @IsUUID()
  serviceId!: string;
}

/**
 * What a customer sees before confirming — V3.3 #159 (`#42b`), `V33-DEC-039`
 * R13, `V33-DEC-042` R2, the #159 preflight's correction 4.
 *
 * ## The checkout's own steps, writing nothing
 *
 * Amounts, seller and terms come from `OrderService.previewForBooking`, the
 * same offering / seller / collection / outcome / pricing sequence order
 * creation runs, inside one read transaction. No booking, hold, order, row,
 * audit or metric is written. A request the checkout would refuse before its
 * acceptance check is refused here with the checkout's own
 * `UnsellableServiceException`, so this read tells a caller nothing the
 * checkout would not.
 *
 * ## Nothing is hard-coded
 *
 * Every number is the snapshot's; the text is the exact published copy version
 * the resolution named; the seller name is the existing public-name source
 * (`provider.professionals` / `business.businesses` `display_name`, the one the
 * finance workspace list already uses) rather than a second one. No evidence
 * reference, cap, case-file period or actor is disclosed.
 */
@Injectable()
export class CheckoutDisclosureService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrderService,
    private readonly slots: AvailabilityService,
    private readonly outcomes: BookingOutcomePolicyResolutionService,
    @Inject(FINANCE_WORKSPACE_LABEL_RESOLVER) private readonly publicNames: FinanceWorkspaceLabelResolver,
  ) {}

  async disclose(customerId: string, query: CheckoutDisclosureQueryDto): Promise<BookingOutcomeDisclosureV1> {
    const slot = await this.slots.findById(query.slotId);
    if (!slot || slot.professionalId !== query.professionalId || slot.startAt.getTime() <= Date.now()) {
      throw new UnsellableServiceException();
    }

    const { preview, copy } = await this.dataSource.transaction(async (manager) => {
      const preview = await this.orders.previewForBooking(manager, {
        customerId,
        professionalId: query.professionalId,
        serviceId: query.serviceId,
      });
      const copy = preview.outcome
        ? await this.outcomes.disclosedCopy(manager, preview.outcome.copyKey, preview.outcome.copyVersion)
        : null;
      return { preview, copy };
    });
    if (preview.outcome && !copy) throw new UnsellableServiceException();

    const party = { partyType: preview.sellerParty.partyType, partyId: preview.sellerParty.partyId };
    const displayName = (await this.publicNames.labelsFor([party])).get(financePartyKey(party));
    if (displayName === undefined) throw new UnsellableServiceException();

    const snapshot = preview.outcome;
    return {
      sellerParty: { kind: party.partyType, displayName },
      amounts: {
        serviceTotalToman: preview.serviceTotalToman,
        platformCollectibleNowToman: preview.platformCollectibleToman,
        venueBalanceToman: preview.venueBalanceToman,
      },
      slotStartsAt: slot.startAt.toISOString(),
      displayTimeZone: BOOKING_OUTCOME_DISPLAY_TIME_ZONE,
      acceptanceRequired: snapshot !== null,
      outcome:
        snapshot && copy
          ? {
              cutoffHours: snapshot.terms.cutoffHours,
              cutoffInstant: new Date(slot.startAt.getTime() - snapshot.terms.cutoffHours * 3_600_000).toISOString(),
              lateCancellationRetention: snapshot.terms.lateCancellationRetention,
              noShowGraceMinutes: snapshot.terms.noShowGraceMinutes,
              noShowRetention: snapshot.terms.noShowRetention,
              rescheduleFreeCountBeforeCutoff: snapshot.terms.rescheduleFreeCountBeforeCutoff,
              disputeWindowHours: snapshot.terms.disputeWindowHours,
              bodilyHarmWindowHours: snapshot.terms.bodilyHarmWindowHours,
              appealWindowHours: snapshot.terms.appealWindowHours,
              copy,
            }
          : null,
      acceptance: snapshot ? acceptanceFor(snapshot) : null,
    };
  }
}

/**
 * `GET /v1/checkout/disclosure` — V3.3 #159 (`#42b`).
 *
 * Its own prefix because `v1/bookings/*` is captured by booking's
 * `GET v1/bookings/:id` (the #159 preflight, correction 4). A customer session,
 * like the checkout it precedes; throttled as a read.
 */
@Throttle(policy('read'))
@Controller('v1/checkout')
export class CheckoutDisclosureController {
  constructor(private readonly disclosure: CheckoutDisclosureService) {}

  @Get('disclosure')
  async disclose(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CheckoutDisclosureQueryDto,
  ): Promise<BookingOutcomeDisclosureV1> {
    return this.disclosure.disclose(user.userId, query);
  }
}
