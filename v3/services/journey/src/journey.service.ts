import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { insertOnce } from '@beauclick/events';
import {
  BeautyGoalCreated,
  BeautyGoalStatusChanged,
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  emitContractEvent,
} from '@beauclick/event-contracts';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import {
  BeautyGoalEntity,
  BeautyProfileEntity,
  GoalStatus,
  JourneyOutboxEntity,
  TimelineEntryEntity,
} from './entities/journey.entities';

export interface UpdateProfileInput {
  preferredCityId?: string | null;
  preferredSpecialtyIds?: string[];
  budgetMinToman?: number | null;
  budgetMaxToman?: number | null;
  notes?: string | null;
}

export interface CreateGoalInput {
  title: string;
  specialtyId?: string | null;
  cityId?: string | null;
  budgetToman?: number | null;
  targetDate?: string | null;
}

export interface TimelineAppendInput {
  userId: string;
  entryType: string;
  sourceType: string;
  sourceId: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Journey's domain logic.
 *
 * Every method takes the user id as its FIRST parameter and every query is
 * scoped by it. Goal mutation is the one operation with its own identifier,
 * and it re-checks ownership by including the user id in the WHERE clause
 * rather than fetching-then-comparing -- a stranger's goal id and a
 * nonexistent one therefore produce byte-identical responses, with no timing
 * difference between them either.
 */
@Injectable()
export class JourneyService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(BeautyProfileEntity) private readonly profiles: Repository<BeautyProfileEntity>,
    @InjectRepository(BeautyGoalEntity) private readonly goals: Repository<BeautyGoalEntity>,
    @InjectRepository(TimelineEntryEntity) private readonly timeline: Repository<TimelineEntryEntity>,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  // ---------------------------------------------------------------- profile

  /**
   * Returns the customer's profile, materializing an empty one if absent.
   *
   * Returning a default rather than null means the client never has to
   * distinguish "no profile yet" from "empty profile", and a PATCH before any
   * GET behaves identically to one after.
   */
  async getProfile(userId: string): Promise<BeautyProfileEntity> {
    const existing = await this.profiles.findOne({ where: { userId } });
    if (existing) return existing;

    return this.profiles.create({
      userId,
      preferredCityId: null,
      preferredSpecialtyIds: [],
      budgetMinToman: null,
      budgetMaxToman: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<BeautyProfileEntity> {
    const current = await this.profiles.findOne({ where: { userId } });

    const next = {
      userId,
      preferredCityId: input.preferredCityId !== undefined ? input.preferredCityId : (current?.preferredCityId ?? null),
      preferredSpecialtyIds:
        input.preferredSpecialtyIds !== undefined ? input.preferredSpecialtyIds : (current?.preferredSpecialtyIds ?? []),
      budgetMinToman: input.budgetMinToman !== undefined ? input.budgetMinToman : (current?.budgetMinToman ?? null),
      budgetMaxToman: input.budgetMaxToman !== undefined ? input.budgetMaxToman : (current?.budgetMaxToman ?? null),
      notes: input.notes !== undefined ? input.notes : (current?.notes ?? null),
    };

    // Upsert on the primary key. Two concurrent PATCHes from the same
    // customer's two tabs resolve to one row rather than one of them failing
    // on a duplicate key.
    await this.profiles
      .createQueryBuilder()
      .insert()
      .values(next)
      .orUpdate(
        ['preferred_city_id', 'preferred_specialty_ids', 'budget_min_toman', 'budget_max_toman', 'notes', 'updated_at'],
        ['user_id'],
      )
      .execute();

    return this.profiles.findOneOrFail({ where: { userId } });
  }

  // ------------------------------------------------------------------ goals

  async listGoals(userId: string, status?: GoalStatus): Promise<BeautyGoalEntity[]> {
    return this.goals.find({
      where: status ? { userId, status } : { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async createGoal(userId: string, input: CreateGoalInput): Promise<BeautyGoalEntity> {
    return this.dataSource.transaction(async (m) => {
      const id = uuidv7();
      await m.getRepository(BeautyGoalEntity).insert({
        id,
        userId,
        title: input.title.trim(),
        specialtyId: input.specialtyId ?? null,
        cityId: input.cityId ?? null,
        budgetToman: input.budgetToman ?? null,
        targetDate: input.targetDate ?? null,
        status: 'active',
      });

      const goal = await m.getRepository(BeautyGoalEntity).findOneOrFail({ where: { id } });

      await emitContractEvent(this.contracts, m, JourneyOutboxEntity, BeautyGoalCreated, {
        aggregateId: id,
        payload: {
          goalId: id,
          userId,
          // `title` deliberately absent -- see journey.events.ts.
          specialtyId: goal.specialtyId,
          cityId: goal.cityId,
          budgetToman: goal.budgetToman,
          targetDate: goal.targetDate,
          createdAt: goal.createdAt.toISOString(),
        },
      });

      // The customer's own timeline entry for setting the goal, written in
      // the same transaction: a goal that exists without its timeline entry
      // would make the journey view silently incomplete.
      await this.appendTimeline(m, {
        userId,
        entryType: 'goal_created',
        sourceType: 'beauty_goal',
        sourceId: id,
        metadata: { specialtyId: goal.specialtyId, cityId: goal.cityId },
        occurredAt: goal.createdAt,
      });

      return goal;
    });
  }

  /**
   * Changes a goal's status.
   *
   * The ownership check is in the UPDATE's WHERE clause, not a preceding
   * SELECT. A stranger's goal id matches zero rows for exactly the same reason
   * a nonexistent one does, so the two are indistinguishable from outside --
   * including in how long they take, which a fetch-then-compare would leak.
   */
  async updateGoalStatus(userId: string, goalId: string, toStatus: GoalStatus): Promise<BeautyGoalEntity> {
    return this.dataSource.transaction(async (m) => {
      const before = await m
        .getRepository(BeautyGoalEntity)
        .findOne({ where: { id: goalId, userId } });
      if (!before) throw new NotFoundOrNotYoursException();
      if (before.status === toStatus) return before;

      const result = await m
        .createQueryBuilder()
        .update(BeautyGoalEntity)
        .set({ status: toStatus })
        .where('id = :goalId AND user_id = :userId AND status = :from', {
          goalId,
          userId,
          from: before.status,
        })
        .execute();

      // Lost the compare-and-swap: another request changed the status first.
      // Returning the current row is correct -- the caller's intent was to
      // move it off `before.status`, and it has moved.
      if (result.affected !== 1) {
        return m.getRepository(BeautyGoalEntity).findOneOrFail({ where: { id: goalId, userId } });
      }

      await emitContractEvent(this.contracts, m, JourneyOutboxEntity, BeautyGoalStatusChanged, {
        aggregateId: goalId,
        payload: {
          goalId,
          userId,
          fromStatus: before.status,
          toStatus,
          changedAt: new Date().toISOString(),
        },
      });

      return m.getRepository(BeautyGoalEntity).findOneOrFail({ where: { id: goalId, userId } });
    });
  }

  // --------------------------------------------------------------- timeline

  async listTimeline(userId: string, limit: number, offset: number): Promise<{ items: TimelineEntryEntity[]; total: number }> {
    const [items, total] = await this.timeline.findAndCount({
      where: { userId },
      order: { occurredAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * Appends a timeline entry, exactly once per (user, entryType, source).
   *
   * Idempotent by the unique index rather than by a preceding existence check,
   * because these are written by event handlers under at-least-once delivery
   * -- a redelivered `BookingCompleted` must add nothing, and two concurrent
   * deliveries must not both pass a check before either inserts.
   *
   * Public and manager-taking so the composition root's handlers can append
   * inside their own transaction.
   */
  async appendTimeline(manager: EntityManager, input: TimelineAppendInput): Promise<boolean> {
    return insertOnce(
      manager
        .createQueryBuilder()
        .insert()
        .into(TimelineEntryEntity)
        .values({
          id: uuidv7(),
          userId: input.userId,
          entryType: input.entryType,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          // TypeORM's QueryDeepPartialEntity narrows a jsonb column's type to
          // its own recursive partial; the cast keeps the public API honest
          // (`Record<string, unknown>`) without widening the column's type.
          metadata: (input.metadata ?? {}) as never,
          occurredAt: input.occurredAt,
        }),
    );
  }

  /** Convenience for handlers that own no transaction of their own. */
  async appendTimelineStandalone(input: TimelineAppendInput): Promise<boolean> {
    return this.dataSource.transaction((m) => this.appendTimeline(m, input));
  }
}
