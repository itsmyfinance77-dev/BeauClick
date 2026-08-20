import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { Public } from '@beauclick/auth';

import { AvailabilityService } from './availability.service';
import { AvailabilitySlotEntity } from '../entities/availability-slot.entity';
import { AvailabilityWindowDto, BulkGenerateSlotsDto, CreateSlotDto } from '../dto/create-slot.dto';
import { PROFESSIONAL_DIRECTORY, ProfessionalDirectory } from '../ports';

function toSlotShape(slot: AvailabilitySlotEntity) {
  return {
    id: slot.id,
    professionalId: slot.professionalId,
    serviceId: slot.serviceId,
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    status: slot.status,
  };
}

/**
 * Public, read-only availability. Exposes only what a customer needs to
 * choose a time, and only slots that are genuinely claimable right now --
 * never `heldUntil`, never `heldByBookingId` (which would leak that
 * somebody else is mid-checkout on a given slot, and expose a booking id).
 */
@Controller('v1/providers')
export class PublicAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Public()
  @Get(':professionalId/availability')
  async list(@Param('professionalId') professionalId: string, @Query() query: AvailabilityWindowDto) {
    const from = query.from ?? new Date();
    const to = query.to ?? new Date(from.getTime() + 14 * 86_400_000);
    const slots = await this.availability.listClaimableSlots(professionalId, { from, to }, query.serviceId ?? null);
    return slots.map((s) => ({
      id: s.id,
      serviceId: s.serviceId,
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
    }));
  }
}

/**
 * A professional's management of their OWN availability.
 *
 * Every route is `/v1/me/...` on purpose: the professional id is derived
 * from the verified session through the directory port, so there is no
 * path parameter for an attacker to tamper with and no ownership resolver
 * to get wrong. V3_SECURITY_MODEL.md §3's "no client-supplied owner IDs",
 * taken to its strongest form -- the id simply is not part of the request.
 */
@Controller('v1/me/availability')
export class MyAvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    @Inject(PROFESSIONAL_DIRECTORY) private readonly directory: ProfessionalDirectory,
  ) {}

  private async requireProfessionalId(user: AuthenticatedUser): Promise<string> {
    const professionalId = await this.directory.professionalIdForOwner(user.userId);
    // Same generic response as "not yours" everywhere else -- a caller with
    // no professional profile learns nothing about the shape of the system.
    if (!professionalId) throw new NotFoundOrNotYoursException();
    return professionalId;
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: AvailabilityWindowDto) {
    const professionalId = await this.requireProfessionalId(user);
    const from = query.from ?? new Date();
    const to = query.to ?? new Date(from.getTime() + 30 * 86_400_000);
    const slots = await this.availability.listForProfessional(professionalId, { from, to });
    return slots.map(toSlotShape);
  }

  @Post('slots')
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSlotDto) {
    const professionalId = await this.requireProfessionalId(user);
    const slot = await this.availability.createSlot(professionalId, {
      startAt: dto.startAt,
      endAt: dto.endAt,
      serviceId: dto.serviceId ?? null,
    });
    return toSlotShape(slot);
  }

  @Post('bulk')
  async bulk(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkGenerateSlotsDto) {
    const professionalId = await this.requireProfessionalId(user);
    return this.availability.bulkGenerate(professionalId, {
      weekdays: dto.weekdays,
      timeStart: dto.timeStart,
      timeEnd: dto.timeEnd,
      slotMinutes: dto.slotMinutes,
      dateFrom: dto.dateFrom,
      dateTo: dto.dateTo,
      serviceId: dto.serviceId ?? null,
    });
  }

  @Delete('slots/:slotId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('slotId') slotId: string) {
    const professionalId = await this.requireProfessionalId(user);
    await this.availability.deleteSlot(professionalId, slotId);
  }
}
