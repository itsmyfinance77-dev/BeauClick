import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { BUSINESS_STAFF_ROLES, BusinessStaffRole } from '../entities/business-staff.entity';

export class InviteStaffDto {
  @IsUUID()
  userId!: string;

  @IsOptional()
  @IsUUID()
  professionalId?: string;

  @IsIn(BUSINESS_STAFF_ROLES)
  role!: BusinessStaffRole;
}

export class ChangeStaffRoleDto {
  @IsIn(BUSINESS_STAFF_ROLES)
  role!: BusinessStaffRole;
}
