<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Rebooking;

/**
 * V2.1 Step 10 — deterministic rebooking eligibility, never AI, never
 * immediately after completion (§17's explicit instructions). Daily sweep:
 * a customer becomes eligible once their MOST RECENT completed booking
 * with a given provider is at least `interval days` old AND they have no
 * upcoming (pending/confirmed) booking with that same provider.
 *
 * The interval is deliberately NOT one silently-invented universal
 * number: `service_meta_interval_days()` lets a specific service override
 * it via `_bc_rebooking_interval_days` postmeta (real "service metadata"
 * per §18's own suggestion), falling back to a filterable, clearly
 * provisional default — see DEFAULT_INTERVAL_DAYS's own docblock. Neither
 * value is presented as final commercial policy.
 */
final class RebookingScheduler {

	public const HOOK = 'beauclick_booking_rebooking_sweep';

	/**
	 * NEEDS_BUSINESS_DECISION: no real interval-per-service-type policy
	 * exists yet (confirmed by inspection -- no such config anywhere in
	 * this codebase before this step). 30 days is a reasonable, clearly
	 * provisional development default for a generic beauty-service
	 * cadence, overridable per-service via postmeta or globally via the
	 * `beauclick/booking/rebooking_interval_days` filter -- never
	 * hardcoded as the only possible value.
	 */
	public const DEFAULT_INTERVAL_DAYS = 30;

	public function register(): void {
		add_action( self::HOOK, [ $this, 'run' ] );
	}

	public function ensure_scheduled(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time(), 'daily', self::HOOK );
		}
	}

	public function unschedule(): void {
		wp_clear_scheduled_hook( self::HOOK );
	}

	public function run(): void {
		if ( ! function_exists( 'beauclick_notifications' ) ) {
			return;
		}

		global $wpdb;
		$now = current_time( 'mysql' );

		// One anchor row per (customer, provider): their own most recent
		// completed booking with that provider. Joining back onto
		// wp_bc_bookings by matching slot_start avoids a correlated
		// subquery per candidate row while staying index-friendly
		// (customer_id/provider_id/status are all already indexed).
		$rows = $wpdb->get_results(
			"SELECT b.id, b.customer_id, b.provider_id, b.service_id, b.slot_start
			 FROM {$wpdb->prefix}bc_bookings b
			 INNER JOIN (
				 SELECT customer_id, provider_id, MAX(slot_start) AS last_visit
				 FROM {$wpdb->prefix}bc_bookings
				 WHERE status = 'completed'
				 GROUP BY customer_id, provider_id
			 ) latest ON latest.customer_id = b.customer_id AND latest.provider_id = b.provider_id AND latest.last_visit = b.slot_start
			 WHERE b.status = 'completed'
			 AND NOT EXISTS (
				 SELECT 1 FROM {$wpdb->prefix}bc_bookings up
				 WHERE up.customer_id = b.customer_id AND up.provider_id = b.provider_id AND up.status IN ('pending','confirmed')
			 )
			 LIMIT 200", // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
			ARRAY_A
		);

		foreach ( $rows ?: [] as $row ) {
			$interval_days = $this->interval_for( $row['service_id'] ? (int) $row['service_id'] : null );
			$due_at        = strtotime( (string) $row['slot_start'] ) + $interval_days * DAY_IN_SECONDS;
			if ( $due_at > strtotime( $now ) ) {
				continue; // Not due yet.
			}

			$provider = get_post( (int) $row['provider_id'] );
			$customer = get_userdata( (int) $row['customer_id'] );
			$service_name = $row['service_id'] ? get_the_title( (int) $row['service_id'] ) : __( 'خدمت قبلی شما', 'beauclick-booking' );

			beauclick_notifications()->notify(
				\BeauClick\Notifications\Preferences\PreferenceService::CATEGORY_REBOOKING,
				\BeauClick\Notifications\Templates\TemplateRegistry::REBOOKING_SUGGESTION,
				(int) $row['customer_id'],
				[
					'customerName' => $customer ? $customer->display_name : '',
					'providerName' => $provider ? $provider->post_title : __( 'متخصص', 'beauclick-booking' ),
					'serviceName'  => $service_name ?: __( 'خدمت قبلی شما', 'beauclick-booking' ),
					'bookingUrl'   => $provider ? ( get_permalink( $provider ) ?: home_url( '/marketplace/' ) ) : home_url( '/marketplace/' ),
				],
				// Scoped to this anchor completed booking -- a later, newer
				// completed visit with the same provider creates a new
				// anchor id, so the customer can be legitimately suggested
				// again after their NEXT visit, not just once ever.
				'rebooking_cycle',
				(int) $row['id'],
				[ 'sms', 'email' ]
			);
		}
	}

	private function interval_for( ?int $service_id ): int {
		if ( $service_id ) {
			$override = get_post_meta( $service_id, '_bc_rebooking_interval_days', true );
			if ( $override && (int) $override > 0 ) {
				return (int) $override;
			}
		}
		return (int) apply_filters( 'beauclick/booking/rebooking_interval_days', self::DEFAULT_INTERVAL_DAYS );
	}
}
