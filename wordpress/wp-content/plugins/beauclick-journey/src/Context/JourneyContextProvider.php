<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Context;

use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Profile\BeautyProfileService;

/**
 * The one seam beauclick-ai calls into (see AssistantService::send()) --
 * Beauty Journey provides context and lifecycle state, the AI module
 * remains solely responsible for recommendation reasoning, per the task's
 * explicit domain boundary ("Journey context -> AI/discovery... The
 * Beauty Journey domain should provide context and lifecycle state").
 *
 * Deliberately returns ONLY the same structured, already-safe shape
 * RuleBasedProvider/CatalogContext have consumed from `ai_context` since
 * V2.0 Step 2 (specialtyIds/cityId/budget) -- zero new AI-side code is
 * needed for this to take effect. The profile's free-text `notes` field is
 * intentionally NEVER included here: it must never reach an external AI
 * provider's prompt (AnthropicProvider serializes the whole context object
 * into its system prompt) without the customer typing it into that specific
 * conversation turn themselves.
 */
final class JourneyContextProvider {

	public function __construct(
		private readonly BeautyProfileService $profiles = new BeautyProfileService(),
		private readonly GoalService $goals = new GoalService()
	) {
	}

	/**
	 * @return array{specialtyIds?: array<int,int>, cityId?: int, budget?: int}
	 * Only ever reads $userId's OWN data -- the caller (AssistantService)
	 * always passes the already-authenticated current user, never a
	 * request-controllable id, so there is no cross-user access path here.
	 */
	public function infer_ai_defaults( int $userId ): array {
		$defaults = [];
		$profile  = $this->profiles->get( $userId );

		if ( $profile['preferredSpecialtyIds'] ) {
			$defaults['specialtyIds'] = $profile['preferredSpecialtyIds'];
		}
		if ( $profile['preferredCityId'] ) {
			$defaults['cityId'] = $profile['preferredCityId'];
		}
		if ( $profile['budgetMax'] ) {
			$defaults['budget'] = $profile['budgetMax'];
		}

		// A specific active goal is a more current, more specific statement
		// of intent than the general profile -- it wins where it overlaps.
		// With more than one active goal, the most recently created one is
		// used (deterministic, no ambiguity about "which goal" to prefer).
		$active = $this->goals->for_user( $userId, 'active' );
		if ( $active ) {
			$goal = $active[0];
			if ( $goal['specialtyId'] ) {
				$defaults['specialtyIds'] = [ $goal['specialtyId'] ];
			}
			if ( $goal['cityId'] ) {
				$defaults['cityId'] = $goal['cityId'];
			}
			if ( $goal['budget'] ) {
				$defaults['budget'] = $goal['budget'];
			}
		}

		return $defaults;
	}
}
