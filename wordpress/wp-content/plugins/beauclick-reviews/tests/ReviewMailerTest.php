<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_UnitTestCase;

final class ReviewMailerTest extends WP_UnitTestCase {

	private array $sent = [];

	public function set_up(): void {
		parent::set_up();
		$this->sent = [];
		add_filter( 'pre_wp_mail', [ $this, 'capture' ], 10, 2 );
	}

	public function tear_down(): void {
		remove_filter( 'pre_wp_mail', [ $this, 'capture' ], 10 );
		parent::tear_down();
	}

	public function capture( $null, array $atts ) {
		$this->sent[] = $atts;
		return true;
	}

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

	public function test_submitting_a_review_emails_the_professional(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id );

		( new ReviewService() )->create( $customer_id, $booking_id, 5, 'عالی بود' );

		$this->assertCount( 1, $this->sent );
		$owner = get_userdata( $owner_id );
		$this->assertSame( $owner->user_email, $this->sent[0]['to'] );
	}
}
