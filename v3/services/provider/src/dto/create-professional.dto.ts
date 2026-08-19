import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateProfessionalDto {
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  specialtyIds?: string[];
}
