import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AuthenticatedUser, CurrentUser, PageQueryDto } from '@beauclick/http';
import { GoalStatus, TimelineEntryEntity } from './entities/journey.entities';
import { JourneyService } from './journey.service';

export class UpdateProfileDto {
  @IsOptional()
  @IsUUID()
  preferredCityId?: string | null;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  // Bounded: an unbounded array here becomes an unbounded `ANY(...)` in every
  // downstream query built from the profile.
  @ArrayMaxSize(20)
  preferredSpecialtyIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMinToman?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMaxToman?: number | null;

  /**
   * Capped at 500 characters, matching the column exactly.
   *
   * The cap is part of the product boundary, not a storage decision: Beauty
   * Journey must not become a medical-record system, and a short free-text
   * field is materially harder to misuse as one than a `TEXT` column would be.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class CreateGoalDto {
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  title!: string;

  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetToman?: number;

  @IsOptional()
  @IsDateString()
  targetDate?: string;
}

export class UpdateGoalStatusDto {
  @IsIn(['active', 'achieved', 'abandoned'])
  status!: GoalStatus;
}

export class ListGoalsDto {
  @IsOptional()
  @IsIn(['active', 'achieved', 'abandoned'])
  status?: GoalStatus;
}

/**
 * The Persian labels for timeline entries, rendered at read time from the
 * stored machine key.
 *
 * Kept out of the database on purpose: storing the label would freeze today's
 * wording into every historical row, so a copy fix would apply only to
 * entries created after it. The same reasoning as commerce's decision to
 * snapshot a line item's PRICE but not its rendered receipt text.
 */
const TIMELINE_LABELS: Record<string, string> = {
  goal_created: 'هدف زیبایی تعریف شد',
  goal_achieved: 'هدف زیبایی محقق شد',
  booking_created: 'رزرو ثبت شد',
  booking_confirmed: 'رزرو تأیید شد',
  booking_completed: 'خدمت انجام شد',
  booking_cancelled: 'رزرو لغو شد',
  order_paid: 'پرداخت انجام شد',
  loyalty_tier_changed: 'سطح باشگاه مشتریان تغییر کرد',
  membership_activated: 'عضویت فعال شد',
};

/**
 * Every route here is self-scoped: the subject is the session user and there
 * is no route or body parameter naming a customer. Goal mutation is the one
 * operation carrying its own id, and the service re-checks ownership inside
 * the query rather than trusting the route.
 */
@Controller('v1/me/journey')
export class JourneyController {
  constructor(private readonly journey: JourneyService) {}

  @Get('profile')
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    const profile = await this.journey.getProfile(user.userId);
    return {
      preferredCityId: profile.preferredCityId,
      preferredSpecialtyIds: profile.preferredSpecialtyIds ?? [],
      budgetMinToman: profile.budgetMinToman,
      budgetMaxToman: profile.budgetMaxToman,
      // Returned to its own author over their own authenticated session --
      // the only direction this field ever travels.
      notes: profile.notes,
    };
  }

  @Patch('profile')
  async updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    const profile = await this.journey.updateProfile(user.userId, dto);
    return {
      preferredCityId: profile.preferredCityId,
      preferredSpecialtyIds: profile.preferredSpecialtyIds ?? [],
      budgetMinToman: profile.budgetMinToman,
      budgetMaxToman: profile.budgetMaxToman,
      notes: profile.notes,
    };
  }

  @Get('goals')
  async listGoals(@CurrentUser() user: AuthenticatedUser, @Query() query: ListGoalsDto) {
    const goals = await this.journey.listGoals(user.userId, query.status);
    return goals.map((g) => ({
      id: g.id,
      title: g.title,
      specialtyId: g.specialtyId,
      cityId: g.cityId,
      budgetToman: g.budgetToman,
      targetDate: g.targetDate,
      status: g.status,
      createdAt: g.createdAt,
    }));
  }

  @Post('goals')
  async createGoal(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateGoalDto) {
    const goal = await this.journey.createGoal(user.userId, dto);
    return { id: goal.id, title: goal.title, status: goal.status, createdAt: goal.createdAt };
  }

  @Patch('goals/:id')
  async updateGoalStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) goalId: string,
    @Body() dto: UpdateGoalStatusDto,
  ) {
    // The user id goes to the service, which puts it in the WHERE clause.
    // Another customer's goal id resolves to the same 404 as a nonexistent one.
    const goal = await this.journey.updateGoalStatus(user.userId, goalId, dto.status);
    return { id: goal.id, status: goal.status };
  }

  @Get('timeline')
  async timeline(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PageQueryDto) {
    const page = pagination.page ?? 1;
    const pageSize = pagination.limit ?? 20;
    const { items, total } = await this.journey.listTimeline(user.userId, pageSize, (page - 1) * pageSize);

    return {
      items: items.map((entry: TimelineEntryEntity) => ({
        type: entry.entryType,
        label: TIMELINE_LABELS[entry.entryType] ?? entry.entryType,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        metadata: entry.metadata,
        occurredAt: entry.occurredAt,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }
}
