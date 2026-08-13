<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Tests;

use BeauClick\Notifications\Preferences\PreferenceService;
use WP_UnitTestCase;

final class PreferenceServiceTest extends WP_UnitTestCase {

	public function test_a_user_with_no_preference_row_defaults_to_enabled(): void {
		$user_id = self::factory()->user->create();
		$this->assertTrue( ( new PreferenceService() )->is_enabled( $user_id, PreferenceService::CATEGORY_REMINDER ) );
	}

	public function test_disabling_a_category_persists_and_is_read_back_correctly(): void {
		$user_id = self::factory()->user->create();
		$service = new PreferenceService();

		$service->update( $user_id, [ PreferenceService::CATEGORY_WAITLIST => false ] );

		$this->assertFalse( $service->is_enabled( $user_id, PreferenceService::CATEGORY_WAITLIST ) );
		$this->assertTrue( $service->is_enabled( $user_id, PreferenceService::CATEGORY_REMINDER ), 'Disabling one category must not affect another.' );
	}

	public function test_updating_the_same_category_twice_upserts_rather_than_duplicating(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();
		$service = new PreferenceService();

		$service->update( $user_id, [ PreferenceService::CATEGORY_REMINDER => false ] );
		$service->update( $user_id, [ PreferenceService::CATEGORY_REMINDER => true ] );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notification_preferences WHERE user_id = %d AND category = %s", $user_id, PreferenceService::CATEGORY_REMINDER ) );
		$this->assertSame( 1, $count );
		$this->assertTrue( $service->is_enabled( $user_id, PreferenceService::CATEGORY_REMINDER ) );
	}

	public function test_an_unknown_category_key_is_silently_ignored_not_written(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();

		( new PreferenceService() )->update( $user_id, [ 'not_a_real_category' => false ] );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notification_preferences WHERE user_id = %d", $user_id ) );
		$this->assertSame( 0, $count, 'A forged/unknown category key must never be written -- silently ignored, not errored, not stored.' );
	}

	public function test_for_user_returns_every_known_category(): void {
		$prefs = ( new PreferenceService() )->for_user( self::factory()->user->create() );
		$this->assertSame( PreferenceService::CATEGORIES, array_keys( $prefs ) );
	}

	public function test_retention_is_the_only_promotional_category(): void {
		$service = new PreferenceService();
		$this->assertSame( PreferenceService::KIND_PROMOTIONAL, $service->kind_of( PreferenceService::CATEGORY_RETENTION ) );
		$this->assertSame( PreferenceService::KIND_TRANSACTIONAL, $service->kind_of( PreferenceService::CATEGORY_REMINDER ) );
		$this->assertSame( PreferenceService::KIND_TRANSACTIONAL, $service->kind_of( PreferenceService::CATEGORY_WAITLIST ) );
		$this->assertSame( PreferenceService::KIND_TRANSACTIONAL, $service->kind_of( PreferenceService::CATEGORY_REBOOKING ) );
	}
}
