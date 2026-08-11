<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Plugin;
use WP_UnitTestCase;

/**
 * A production-readiness audit found no timezone ever configured for this
 * Iran-only platform — WordPress silently defaults to UTC, which several
 * booking-availability date comparisons assumed was already site-local.
 */
final class TimezoneTest extends WP_UnitTestCase {

	public function test_activation_sets_asia_tehran_when_the_timezone_is_still_wordpress_default(): void {
		update_option( 'timezone_string', '' );
		update_option( 'gmt_offset', 0 );

		Plugin::activate();

		$this->assertSame( 'Asia/Tehran', get_option( 'timezone_string' ) );
	}

	public function test_activation_never_overwrites_a_timezone_an_admin_deliberately_set(): void {
		update_option( 'timezone_string', 'Europe/London' );

		Plugin::activate();

		$this->assertSame( 'Europe/London', get_option( 'timezone_string' ), "A deliberately-configured timezone must survive re-activation, not be silently reset to Asia/Tehran." );
	}

	public function test_activation_never_overwrites_a_custom_gmt_offset(): void {
		update_option( 'timezone_string', '' );
		update_option( 'gmt_offset', 2 );

		Plugin::activate();

		$this->assertSame( '', get_option( 'timezone_string' ), "A non-zero gmt_offset means an admin already configured this deliberately — must not be overridden." );
	}
}
