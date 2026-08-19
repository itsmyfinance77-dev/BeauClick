import { IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '@beauclick/http';

export class ListProvidersDto extends PageQueryDto {
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @IsUUID()
  specialtyId?: string;
}
