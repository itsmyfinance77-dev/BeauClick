<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Reviews\Admin\ReviewsAdminPage;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_UnitTestCase;

/**
 * V2.2 Step 13 — the general admin audit log (ADMIN-02) must record every
 * review moderation decision. moderate_and_log() is tested directly (not
 * handle_moderate(), which ends in wp_safe_redirect()+exit and can't run
 * inside a test process) — the same "extract the testable core, keep the
 * redirect wrapper thin" pattern used for AccountsAdminPage/LoyaltyAdminPage.
 */
final class ReviewsAdminPageTest extends WP_UnitTestCase {

	private function make_booking( int $customer_id, int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 1,
				'slot_start'  => '2026-09-01 10:00:00',
				'slot_end'    => '2026-09-01 11:00:00',
				'status'      => 'completed',
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	private function make_review( int $author_id, int $provider_id, int $booking_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_reviews',
			[
				'author_id'   => $author_id,
				'target_type' => 'provider',
				'target_id'   => $provider_id,
				'booking_id'  => $booking_id,
				'rating'      => 5,
				'body'        => 'عالی بود',
				'status'      => 'pending',
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	public function test_moderate_and_log_writes_an_audit_row_with_before_and_after_status(): void {
		global $wpdb;

		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$author_id   = self::factory()->user->create();
		$booking_id  = $this->make_booking( $author_id, $provider_id );
		$review_id   = $this->make_review( $author_id, $provider_id, $booking_id );

		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		( new ReviewsAdminPage() )->moderate_and_log( $review_id, 'approved' );

		$this->assertSame( 'approved', ( new ReviewService() )->find( $review_id )['status'] );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'review_moderated', $row['action_type'] );
		$this->assertSame( 'review', $row['entity_type'] );
		$this->assertSame( $review_id, (int) $row['entity_id'] );
		$this->assertSame( $moderator_id, (int) $row['actor_user_id'] );
		$this->assertSame( [ 'status' => 'pending' ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'status' => 'approved' ], json_decode( $row['new_state'], true ) );
	}
}
