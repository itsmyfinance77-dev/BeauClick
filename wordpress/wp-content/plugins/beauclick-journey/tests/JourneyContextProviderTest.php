<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Tests;

use BeauClick\Journey\Context\JourneyContextProvider;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Profile\BeautyProfileService;
use WP_UnitTestCase;

final class JourneyContextProviderTest extends WP_UnitTestCase {

	public function test_a_user_with_no_journey_data_yields_empty_defaults(): void {
		$user_id  = self::factory()->user->create();
		$defaults = ( new JourneyContextProvider() )->infer_ai_defaults( $user_id );

		$this->assertSame( [], $defaults, 'AI must behave exactly as it did before Beauty Journey existed when there is no journey data yet.' );
	}

	public function test_profile_preferences_are_used_as_defaults(): void {
		$user_id = self::factory()->user->create();
		( new BeautyProfileService() )->update( $user_id, [ 'preferredCityId' => 37, 'preferredSpecialtyIds' => [ 16 ], 'budgetMax' => 2000000 ] );

		$defaults = ( new JourneyContextProvider() )->infer_ai_defaults( $user_id );

		$this->assertSame( 37, $defaults['cityId'] );
		$this->assertSame( [ 16 ], $defaults['specialtyIds'] );
		$this->assertSame( 2000000, $defaults['budget'] );
	}

	public function test_an_active_goals_fields_take_precedence_over_the_general_profile(): void {
		$user_id = self::factory()->user->create();
		( new BeautyProfileService() )->update( $user_id, [ 'preferredCityId' => 10, 'budgetMax' => 500000 ] );
		( new GoalService() )->create( $user_id, 'هدف خاص', 19, 37, 3000000, null );

		$defaults = ( new JourneyContextProvider() )->infer_ai_defaults( $user_id );

		$this->assertSame( 37, $defaults['cityId'], 'The active goal is more specific/current than the general profile and must win.' );
		$this->assertSame( [ 19 ], $defaults['specialtyIds'] );
		$this->assertSame( 3000000, $defaults['budget'] );
	}

	public function test_an_achieved_goal_no_longer_influences_defaults(): void {
		$user_id = self::factory()->user->create();
		$goals   = new GoalService();
		$goal    = $goals->create( $user_id, 'هدف قدیمی', 19, 37, 3000000, null );
		$goals->update( $goal['id'], [ 'status' => 'achieved' ] );

		$defaults = ( new JourneyContextProvider() )->infer_ai_defaults( $user_id );

		$this->assertArrayNotHasKey( 'cityId', $defaults, 'A goal that is no longer active must not influence AI defaults.' );
	}

	public function test_another_users_journey_data_never_leaks_into_this_users_defaults(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		( new BeautyProfileService() )->update( $user_a, [ 'preferredCityId' => 37 ] );

		$defaults_b = ( new JourneyContextProvider() )->infer_ai_defaults( $user_b );

		$this->assertArrayNotHasKey( 'cityId', $defaults_b );
	}
}
