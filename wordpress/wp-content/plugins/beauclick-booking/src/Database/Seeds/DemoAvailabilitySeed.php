<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Database\Seeds;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * Open availability slots for the next 7 days for every seeded demo
 * professional (3 fixed times/day), so the booking flow — date picker,
 * time grid, create booking — has real data to exercise locally. Idempotent:
 * skips a provider that already has any future open slot.
 */
final class DemoAvailabilitySeed {

	private const TIMES = [ '10:00', '13:00', '16:00' ];

	public static function run(): void {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_availability_slots';

		$providers = get_posts(
			[
				'post_type'      => Registrar::PROFESSIONAL,
				'post_status'    => 'publish',
				'posts_per_page' => -1,
			]
		);

		foreach ( $providers as $provider ) {
			$has_future = $wpdb->get_var(
				$wpdb->prepare( "SELECT id FROM {$table} WHERE provider_id = %d AND status = 'open' AND start_at >= %s LIMIT 1", $provider->ID, current_time( 'mysql' ) ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			);
			if ( $has_future ) {
				continue;
			}

			for ( $day = 0; $day < 7; $day++ ) {
				$date = gmdate( 'Y-m-d', strtotime( "+{$day} days" ) );
				foreach ( self::TIMES as $time ) {
					$start = "{$date} {$time}:00";
					$end   = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );

					$wpdb->insert(
						$table,
						[
							'provider_id' => $provider->ID,
							'service_id'  => null,
							'start_at'    => $start,
							'end_at'      => $end,
							'status'      => 'open',
							'created_at'  => current_time( 'mysql' ),
						]
					);
				}
			}
		}
	}
}
