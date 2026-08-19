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
