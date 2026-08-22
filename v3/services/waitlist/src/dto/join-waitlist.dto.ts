import { IsOptional, IsUUID } from 'class-validator';

export class JoinWaitlistDto {
  @IsUUID()
  professionalId!: string;

  @IsOptional()
  @IsUUID()
  serviceId?: string;
}
