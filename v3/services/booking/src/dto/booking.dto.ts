import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Note what is NOT here: no price, no total, no discount, no currency.
 *
 * The client names WHAT it wants (professional, service, slot) and never
 * WHAT IT COSTS. Every monetary figure is derived server-side from the
 * professional's own catalogue by the pricing engine -- a client-supplied
 * amount would be trusted input on the one field that must never be
 * trusted. `forbidNonWhitelisted` on the global ValidationPipe makes a
 * request that tries to smuggle a `priceToman` field fail outright rather
 * than have it silently stripped.
 */
export class CreateBookingDto {
  @IsUUID()
  professionalId!: string;

  @IsUUID()
  slotId!: string;

  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

export class CancelBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class RescheduleBookingDto {
  @IsUUID()
  newSlotId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
