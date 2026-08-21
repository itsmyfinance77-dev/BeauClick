import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BeautyGoalEntity, BeautyProfileEntity } from './entities/journey.entities';

/**
 * The AI context boundary, expressed as a type.
 *
 * Every field is a structured identifier or a number. There is deliberately
 * NO string field of any kind, and that is the enforcement mechanism: a future
 * author who wanted to pass the customer's notes into an AI prompt would have
 * to add a field to this interface, which is a visible, reviewable act, rather
 * than spreading a profile object and not noticing.
 *
 * V2 got this rule right and documented it well -- `JourneyContextProvider`'s
 * docblock is explicit that `notes` must never reach an external provider's
 * prompt because `AnthropicProvider` serializes the whole context object into
 * its system prompt. But V2 enforced it by returning a hand-built array and
 * remembering not to include the field. This version makes the omission
 * structural.
 */
export interface JourneyAiContext {
  specialtyIds?: string[];
  cityId?: string;
  budgetToman?: number;
}

/**
 * The ONE seam an AI module may call into Journey through.
 *
 * Note the signature: it takes a user id and returns a context. It does not
 * take a request, a session, or a flag — **authorization must have already
 * happened before this is called**, and the caller passes the id of the
 * already-authenticated user. That ordering is the rule §16 requires
 * ("authorization must occur before context assembly"), and keeping this
 * function incapable of authorizing anything is what stops it from becoming
 * the place where the check is accidentally skipped.
 */
@Injectable()
export class JourneyContextProvider {
  constructor(
    @InjectRepository(BeautyProfileEntity) private readonly profiles: Repository<BeautyProfileEntity>,
    @InjectRepository(BeautyGoalEntity) private readonly goals: Repository<BeautyGoalEntity>,
  ) {}

  /**
   * Builds the typed context for a customer.
   *
   * A specific ACTIVE goal is a more current, more specific statement of
   * intent than the standing profile, so it wins where the two overlap. With
   * several active goals the most recently created one is used -- deterministic,
   * so the AI's suggestions do not change between two identical requests.
   *
   * `budgetMax` rather than `budgetMin` is what travels: the question an AI
   * answers is "what can you afford", and a minimum budget would produce
   * recommendations that exclude everything cheap, which is the opposite of
   * what a customer with a floor preference wants.
   */
  async inferAiDefaults(userId: string): Promise<JourneyAiContext> {
    const context: JourneyAiContext = {};

    const profile = await this.profiles.findOne({ where: { userId } });
    if (profile) {
      if (profile.preferredSpecialtyIds?.length) context.specialtyIds = profile.preferredSpecialtyIds;
      if (profile.preferredCityId) context.cityId = profile.preferredCityId;
      if (profile.budgetMaxToman) context.budgetToman = profile.budgetMaxToman;
      // `profile.notes` is read into memory here and deliberately never
      // assigned. See this file's header.
    }

    const [activeGoal] = await this.goals.find({
      where: { userId, status: 'active' },
      order: { createdAt: 'DESC' },
      take: 1,
    });

    if (activeGoal) {
      if (activeGoal.specialtyId) context.specialtyIds = [activeGoal.specialtyId];
      if (activeGoal.cityId) context.cityId = activeGoal.cityId;
      if (activeGoal.budgetToman) context.budgetToman = activeGoal.budgetToman;
      // `activeGoal.title` is customer-authored free text and is likewise
      // never assigned -- the goal's structured intent travels, its wording
      // does not.
    }

    return context;
  }
}
