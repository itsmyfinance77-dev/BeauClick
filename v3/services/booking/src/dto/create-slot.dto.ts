import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDate, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

export class CreateSlotDto {
  @Type(() => Date)
  @IsDate()
  startAt!: Date;

  @Type(() => Date)
  @IsDate()
  endAt!: Date;

  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

export class BulkGenerateSlotsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'timeStart must be HH:mm' })
  timeStart!: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'timeEnd must be HH:mm' })
  timeEnd!: string;

  @Type(() => Number)
  @IsInt()
  slotMinutes!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo!: string;

  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

export class AvailabilityWindowDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsUUID()
  serviceId?: string;
}
