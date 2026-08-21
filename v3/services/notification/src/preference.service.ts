import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import {
  MANDATORY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NotificationCategory,
  NotificationPreferenceEntity,
} from './entities/notification.entities';

/**
 * Per-CATEGORY, opt-out preferences.
 *
 * Per category and NOT per category-per-channel: a combinatorial matrix
 * nobody asked for is a settings screen nobody can use. V2 made this call
 * explicitly and it holds.
 *
 * Absence of a row means ENABLED. Two consequences, both deliberate: a
 * customer who has never opened their settings still receives the reminders
 * they would expect, and the table grows only when someone actually changes
 * something rather than carrying a row per user per category from day one.
 */
@Injectable()
export class PreferenceService {
  constructor(
    @InjectRepository(NotificationPreferenceEntity)
    private readonly preferences: Repository<NotificationPreferenceEntity>,
  ) {}

  /**
   * Whether a category may be delivered to this user.
   *
   * Mandatory categories short-circuit to true WITHOUT reading the table.
   * That is the important line: even if a row somehow existed saying
   * `booking: false` — written by a bug, a bad migration, or a direct SQL
   * edit — a booking confirmation still goes out. The schema's CHECK
   * constraint prevents such a row existing; this makes it harmless if one
   * somehow did. Two independent layers, because a suppressed payment receipt
   * is a customer with money gone and no record of why.
   */
  async isEnabled(userId: string, category: NotificationCategory): Promise<boolean> {
    if (MANDATORY_CATEGORIES.includes(category)) return true;

    const row = await this.preferences.findOne({ where: { userId, category } });
    return row ? row.enabled : true;
  }

  /** Every category with its effective value, materializing nothing. */
  async forUser(userId: string): Promise<Array<{ category: NotificationCategory; enabled: boolean; mandatory: boolean }>> {
    const rows = await this.preferences.find({ where: { userId } });
    const byCategory = new Map(rows.map((r) => [r.category, r.enabled]));

    return NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      enabled: MANDATORY_CATEGORIES.includes(category) ? true : (byCategory.get(category) ?? true),
      mandatory: MANDATORY_CATEGORIES.includes(category),
    }));
  }

  /**
   * Updates preferences.
   *
   * An unknown category key is IGNORED rather than rejected, matching V2:
   * a forged or stale key from an old client must never be able to write an
   * arbitrary row, and erroring the whole request because one key in a batch
   * is unrecognised would break a client mid-rollout.
   *
   * A mandatory category is likewise ignored rather than erroring -- the
   * request to disable it is simply not honoured, and the response shows the
   * true state, so the client can see it did not take effect.
   */
  async update(
    userId: string,
    updates: Partial<Record<NotificationCategory, boolean>>,
  ): Promise<Array<{ category: NotificationCategory; enabled: boolean; mandatory: boolean }>> {
    for (const [rawCategory, enabled] of Object.entries(updates)) {
      const category = rawCategory as NotificationCategory;
      if (!NOTIFICATION_CATEGORIES.includes(category)) continue;
      if (MANDATORY_CATEGORIES.includes(category)) continue;
      if (typeof enabled !== 'boolean') continue;

      await this.preferences
        .createQueryBuilder()
        .insert()
        .values({ id: uuidv7(), userId, category, enabled, updatedAt: new Date() })
        .orUpdate(['enabled', 'updated_at'], ['user_id', 'category'])
        .execute();
    }

    return this.forUser(userId);
  }
}
