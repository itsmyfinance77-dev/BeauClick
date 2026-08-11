<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Tests;

use BeauClick\Reviews\Rest\ReviewsController;
use WP_UnitTestCase;

final class ReviewsControllerTest extends WP_UnitTestCase {

	public function test_a_logged_out_visitor_cannot_write_a_review(): void {
		wp_set_current_user( 0 );
		$this->assertInstanceOf( \WP_Error::class, ( new ReviewsController() )->can_write() );
	}

	public function test_a_logged_in_customer_can_write_a_review(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );
		$this->assertTrue( ( new ReviewsController() )->can_write() );
	}
}
