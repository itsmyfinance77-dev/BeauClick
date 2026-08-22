import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateBusinessDto {
  @IsString()
  @Length(2, 120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bio?: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;
}
