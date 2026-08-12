<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Tests;

use BeauClick\Journey\Profile\BeautyProfileService;
use WP_UnitTestCase;

final class BeautyProfileServiceTest extends WP_UnitTestCase {

	public function test_a_user_with_no_profile_gets_an_empty_default_shape_not_a_404(): void {
		$user_id = self::factory()->user->create();
		$profile = ( new BeautyProfileService() )->get( $user_id );

		$this->assertSame( $user_id, $profile['userId'] );
		$this->assertNull( $profile['preferredCityId'] );
		$this->assertSame( [], $profile['preferredSpecialtyIds'] );
		$this->assertNull( $profile['notes'] );
	}

	public function test_updating_creates_a_profile_on_first_write(): void {
		$user_id = self::factory()->user->create();
		$service = new BeautyProfileService();

		$updated = $service->update( $user_id, [ 'preferredCityId' => 37, 'budgetMax' => 2000000 ] );

		$this->assertSame( 37, $updated['preferredCityId'] );
		$this->assertSame( 2000000, $updated['budgetMax'] );
	}

	public function test_patch_semantics_only_change_supplied_fields(): void {
		$user_id = self::factory()->user->create();
		$service = new BeautyProfileService();

		$service->update( $user_id, [ 'preferredCityId' => 37, 'budgetMax' => 2000000 ] );
		$after = $service->update( $user_id, [ 'budgetMax' => 3000000 ] );

		$this->assertSame( 37, $after['preferredCityId'], 'A field not included in the PATCH must remain unchanged.' );
		$this->assertSame( 3000000, $after['budgetMax'] );
	}

	public function test_preferred_specialty_ids_round_trip_as_an_array(): void {
		$user_id = self::factory()->user->create();
		$service = new BeautyProfileService();

		$updated = $service->update( $user_id, [ 'preferredSpecialtyIds' => [ 16, 18 ] ] );

		$this->assertSame( [ 16, 18 ], $updated['preferredSpecialtyIds'] );
	}

	public function test_notes_are_sanitized_and_length_capped(): void {
		$user_id = self::factory()->user->create();
		$service = new BeautyProfileService();

		$long = str_repeat( 'الف', 300 ); // Well beyond the 500-char cap.
		$updated = $service->update( $user_id, [ 'notes' => $long ] );

		$this->assertLessThanOrEqual( 500, mb_strlen( $updated['notes'] ) );
	}

	public function test_notes_can_be_explicitly_cleared_with_an_empty_string(): void {
		$user_id = self::factory()->user->create();
		$service = new BeautyProfileService();

		$service->update( $user_id, [ 'notes' => 'یادداشت اولیه' ] );
		$cleared = $service->update( $user_id, [ 'notes' => '' ] );

		$this->assertNull( $cleared['notes'] );
	}

	public function test_a_users_profile_is_never_visible_to_another_user_through_the_service(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		$service = new BeautyProfileService();

		$service->update( $user_a, [ 'notes' => 'یادداشت خصوصی من' ] );

		$this->assertNull( $service->get( $user_b )['notes'], "Requesting another user's id must never return the first user's data." );
	}
}
