<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Tests;

use BeauClick\Journey\Goals\GoalService;
use WP_UnitTestCase;

final class GoalServiceTest extends WP_UnitTestCase {

	public function test_creating_a_goal_persists_it_and_logs_exactly_one_event(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();

		$goal = ( new GoalService() )->create( $user_id, 'آماده شدن برای عروسی', 16, 37, 2000000, '2026-12-01' );

		$this->assertIsArray( $goal );
		$this->assertSame( 'آماده شدن برای عروسی', $goal['title'] );
		$this->assertSame( 16, $goal['specialtyId'] );
		$this->assertSame( 37, $goal['cityId'] );
		$this->assertSame( 2000000, $goal['budget'] );
		$this->assertSame( 'active', $goal['status'] );

		$event_count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'goal_created' AND entity_type = 'goal' AND entity_id = %d AND actor_id = %d", $goal['id'], $user_id )
		);
		$this->assertSame( 1, $event_count, 'Creating a goal must write exactly one goal_created event, never zero or two.' );
	}

	public function test_a_blank_title_is_rejected(): void {
		$user_id = self::factory()->user->create();
		$result  = ( new GoalService() )->create( $user_id, '   ', null, null, null, null );

		$this->assertIsString( $result );
	}

	public function test_a_goal_with_only_a_title_is_valid(): void {
		$user_id = self::factory()->user->create();
		$goal    = ( new GoalService() )->create( $user_id, 'یک هدف ساده', null, null, null, null );

		$this->assertIsArray( $goal );
		$this->assertNull( $goal['specialtyId'] );
		$this->assertNull( $goal['targetDate'] );
	}

	public function test_for_user_returns_only_that_users_own_goals(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		$service = new GoalService();

		$service->create( $user_a, 'هدف الف', null, null, null, null );
		$service->create( $user_b, 'هدف ب', null, null, null, null );

		$goals_a = $service->for_user( $user_a );
		$this->assertCount( 1, $goals_a );
		$this->assertSame( 'هدف الف', $goals_a[0]['title'] );
	}

	public function test_filtering_by_status_only_returns_matching_goals(): void {
		$user_id = self::factory()->user->create();
		$service = new GoalService();

		$active   = $service->create( $user_id, 'فعال', null, null, null, null );
		$achieved = $service->create( $user_id, 'محقق‌شده', null, null, null, null );
		$service->update( $achieved['id'], [ 'status' => 'achieved' ] );

		$active_only = $service->for_user( $user_id, 'active' );
		$this->assertCount( 1, $active_only );
		$this->assertSame( $active['id'], $active_only[0]['id'] );
	}

	public function test_updating_status_to_an_invalid_value_is_rejected(): void {
		$user_id = self::factory()->user->create();
		$goal    = ( new GoalService() )->create( $user_id, 'هدف', null, null, null, null );

		$result = ( new GoalService() )->update( $goal['id'], [ 'status' => 'not-a-real-status' ] );

		$this->assertIsString( $result );
	}

	public function test_updating_only_changes_supplied_fields(): void {
		$user_id = self::factory()->user->create();
		$goal    = ( new GoalService() )->create( $user_id, 'هدف اولیه', 16, 37, 1000000, null );

		$updated = ( new GoalService() )->update( $goal['id'], [ 'status' => 'achieved' ] );

		$this->assertSame( 'achieved', $updated['status'] );
		$this->assertSame( 'هدف اولیه', $updated['title'], 'A field not included in the update must remain unchanged.' );
		$this->assertSame( 16, $updated['specialtyId'] );
	}
}
