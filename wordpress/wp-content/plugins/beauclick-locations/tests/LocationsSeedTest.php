<?php
declare( strict_types=1 );

namespace BeauClick\Locations\Tests;

use BeauClick\Locations\Database\Seeds\IranLocationsSeed;
use WP_UnitTestCase;

final class LocationsSeedTest extends WP_UnitTestCase {

	public function test_seeds_all_31_provinces(): void {
		$this->assertCount( 31, IranLocationsSeed::data(), 'Iran has 31 provinces — the location model must cover all of them from day one, not just the launch city.' );
	}

	public function test_run_is_idempotent(): void {
		global $wpdb;

		IranLocationsSeed::run();
		$first_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_provinces" );

		IranLocationsSeed::run();
		$second_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_provinces" );

		$this->assertSame( $first_count, $second_count, 'Running the seed twice must not duplicate rows.' );
		$this->assertSame( 31, $first_count );
	}

	public function test_only_yazd_tehran_isfahan_are_launched(): void {
		global $wpdb;
		IranLocationsSeed::run();

		$launched = $wpdb->get_col( "SELECT slug FROM {$wpdb->prefix}bc_cities WHERE is_launched = 1 ORDER BY slug" );

		$this->assertSame( [ 'isfahan', 'tehran', 'yazd' ], $launched, 'Only the design handoff\'s example filter chips should be launched by default — everything else is real reference data waiting to be flipped on, never hard-coded as unreachable.' );
	}

	public function test_yazd_city_has_districts(): void {
		global $wpdb;
		IranLocationsSeed::run();

		$yazd_city_id = $wpdb->get_var( "SELECT id FROM {$wpdb->prefix}bc_cities WHERE slug = 'yazd'" );
		$district_count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_districts WHERE city_id = %d", $yazd_city_id ) );

		$this->assertGreaterThanOrEqual( 4, $district_count, 'The launch city needs real neighborhood-level granularity.' );
	}
}
