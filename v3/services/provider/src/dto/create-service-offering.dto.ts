import { PartialType } from '@nestjs/mapped-types';
import { IsInt, IsString, Length, Min } from 'class-validator';

export class CreateServiceOfferingDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsInt()
  @Min(5)
  durationMinutes!: number;

  @IsInt()
  @Min(0)
  priceToman!: number;
}

/**
 * Every field optional, same constraints when present.
 *
 * `PartialType` rather than a hand-copied class, matching
 * `UpdateProfessionalDto`'s own precedent -- a second copy of the
 * constraints is a second place for them to drift.
 */
export class UpdateServiceOfferingDto extends PartialType(CreateServiceOfferingDto) {}
