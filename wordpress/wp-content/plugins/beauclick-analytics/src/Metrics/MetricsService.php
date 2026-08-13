<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Metrics;

/**
 * Every metric below is computed LIVE, directly from wp_bc_events and the
 * existing domain tables (wp_bc_bookings, wp_bc_waitlist_entries,
 * wp_bc_notifications, wp_users, wp_posts) -- there is no pre-aggregated
 * "daily metrics" table and no cron job computing one.
 *
 * That is a deliberate architecture decision for this step, not an
 * oversight: at this project's current, real event volume (order of
 * thousands of rows, confirmed by direct inspection of wp_bc_events during
 * the V2.2 planning/recovery pass), an indexed COUNT/SUM/GROUP BY over a
 * bounded date range (normalize_range() caps every query to at most 366
 * days) is fast and needs no caching layer. Introducing a daily-aggregate
 * table now would mean building and maintaining a second source of truth
 * (a cron job, a backfill path, a staleness/cache-invalidation story) for
 * a performance problem that does not yet exist -- exactly what the task's
 * own "no infrastructure overreach" instruction (§36/§17) warns against.
 * If real usage ever makes live aggregation measurably too slow, the
 * natural next step is a `wp_bc_analytics_daily_metrics` cache table keyed
 * by (metric_key, date) computed by a nightly WP-Cron job — not a new
 * datastore, just a cache in front of these same queries. Not built here
 * because there is no evidence yet that it's needed.
 *
 * created_at on every wp_bc_* table used here is written via
 * current_time('mysql') -- i.e. it is already the site's local wall-clock
 * time (Asia/Tehran, per beauclick-core's own activation-time default),
 * never raw UTC. That is exactly why every query below can group/filter by
 * plain `DATE(created_at)`/`BETWEEN` without any timezone conversion, and
 * why a caller may safely pass in plain Y-m-d calendar-date boundaries.
 */
final class MetricsService {

	private const NOTIFICATION_CATEGORIES = [ 'reminder', 'waitlist', 'rebooking', 'retention' ];

	/**
	 * Normalizes raw (possibly absent/malformed) from/to request params into
	 * two safe Y-m-d strings: defaults to the last 30 days, swaps a reversed
	 * range, and clamps the window to at most 366 days so a mistyped/adversarial
	 * range can never turn every metric query into an unbounded table scan.
	 *
	 * @return array{0:string,1:string}
	 */
	public static function normalize_range( ?string $from, ?string $to ): array {
		$today = current_time( 'Y-m-d' );

		$from = ( $from && preg_match( '/^\d{4}-\d{2}-\d{2}$/', $from ) ) ? $from : gmdate( 'Y-m-d', strtotime( $today . ' -29 days' ) );
		$to   = ( $to && preg_match( '/^\d{4}-\d{2}-\d{2}$/', $to ) ) ? $to : $today;

		if ( $from > $to ) {
			[ $from, $to ] = [ $to, $from ];
		}

		$max_days = 366;
		if ( ( strtotime( $to ) - strtotime( $from ) ) / DAY_IN_SECONDS > $max_days ) {
			$from = gmdate( 'Y-m-d', strtotime( "{$to} -{$max_days} days" ) );
		}

		return [ $from, $to ];
	}

	/** @return array{0:string,1:string} full-day datetime bounds for a BETWEEN clause. */
	private static function bounds( string $from, string $to ): array {
		return [ $from . ' 00:00:00', $to . ' 23:59:59' ];
	}

	private static function ratio( int $numerator, int $denominator ): float {
		return $denominator > 0 ? round( $numerator / $denominator, 4 ) : 0.0;
	}

	private function count_events( string $event_type, string $from, string $to ): int {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND created_at BETWEEN %s AND %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$start,
				$end
			)
		);
	}

	private function count_distinct_actors( string $event_type, string $from, string $to ): int {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(DISTINCT actor_id) FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND actor_id IS NOT NULL AND created_at BETWEEN %s AND %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$start,
				$end
			)
		);
	}

	private function sum_event_meta_total( string $event_type, string $from, string $to ): float {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );
		$value = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.total')) AS DECIMAL(18,2))) FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND created_at BETWEEN %s AND %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$start,
				$end
			)
		);
		return (float) ( $value ?? 0 );
	}

	private function count_meta_bool_true( string $event_type, string $meta_key, string $from, string $to ): int {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND created_at BETWEEN %s AND %s AND JSON_UNQUOTE(JSON_EXTRACT(meta, %s)) = 'true'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$start,
				$end,
				'$.' . $meta_key
			)
		);
	}

	/**
	 * Platform-wide snapshot: signups/users/professionals/orders. "Orders
	 * completed"/"gross revenue" here deliberately include BOTH booking-
	 * originated and genuine shop/B2B orders (order_completed is one shared
	 * event for both, per beauclick-payments' Plugin.php) — this section is
	 * the whole-platform total; see commerce() for the shop-only funnel that
	 * explicitly excludes booking orders to avoid double-counting the two
	 * funnels against each other.
	 */
	public function overview( string $from, string $to ): array {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );

		$new_signups = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->users} WHERE user_registered BETWEEN %s AND %s", $start, $end ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		$active_professionals = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'bc_professional' AND post_status = 'publish'" // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		);

		$gross_revenue    = $this->sum_event_meta_total( 'order_completed', $from, $to );
		$refunded_amount  = $this->sum_event_meta_total( 'order_refunded', $from, $to );

		return [
			'newSignups'              => $new_signups,
			'usersByRole'             => [
				'customer'        => (int) ( count_users()['avail_roles']['customer'] ?? 0 ),
				'bc_professional' => (int) ( count_users()['avail_roles']['bc_professional'] ?? 0 ),
				'bc_business'     => (int) ( count_users()['avail_roles']['bc_business'] ?? 0 ),
			],
			'activeProfessionals'     => $active_professionals,
			'bookingsCompleted'       => $this->count_events( 'booking_completed', $from, $to ),
			'ordersCompletedAllTypes' => $this->count_events( 'order_completed', $from, $to ),
			'grossRevenueAllTypes'    => $gross_revenue,
			'refundedAmountAllTypes'  => $refunded_amount,
			'netRevenueAllTypes'      => $gross_revenue - $refunded_amount,
		];
	}

	/**
	 * Booking funnel — source: wp_bc_events (booking_created/_confirmed/
	 * _completed/_cancelled/_expired/_no_show), already logged from inside
	 * BookingService's own atomic status transitions (see the recon this
	 * step's planning pass did on EventLogger's call sites) — this method
	 * adds no new booking events, only reads and defines the conversion
	 * metric on top of what already exists.
	 */
	public function funnel( string $from, string $to ): array {
		$started   = $this->count_events( 'booking_created', $from, $to );
		$confirmed = $this->count_events( 'booking_confirmed', $from, $to );
		$completed = $this->count_events( 'booking_completed', $from, $to );

		return [
			'started'         => $started,
			'confirmed'       => $confirmed,
			'completed'       => $completed,
			'cancelled'       => $this->count_events( 'booking_cancelled', $from, $to ),
			'expired'         => $this->count_events( 'booking_expired', $from, $to ),
			'noShow'          => $this->count_events( 'booking_no_show', $from, $to ),
			'conversionRate'  => self::ratio( $completed, $started ),
		];
	}

	/**
	 * Shop/B2B commerce funnel — product_view/cart_add/checkout_started are
	 * new events this step adds (CommerceTracker), hooked to genuine
	 * WooCommerce cart lifecycle actions that a booking purchase never fires
	 * (BookingOrderBridge bypasses the cart entirely — see CommerceTracker's
	 * own docblock). "ordersCompleted"/"ordersRefunded" here are explicitly
	 * filtered to EXCLUDE any order_completed/order_refunded event whose
	 * order id is linked to a booking (wp_bc_bookings.wc_order_id), so this
	 * funnel's own conversion rate isn't distorted by orders that never went
	 * through checkout_started in the first place.
	 */
	public function commerce( string $from, string $to ): array {
		$checkout_started = $this->count_events( 'checkout_started', $from, $to );
		$orders_completed = $this->shop_order_event_count( 'order_completed', $from, $to );

		return [
			'productViews'           => $this->count_events( 'product_view', $from, $to ),
			'cartAdds'                => $this->count_events( 'cart_add', $from, $to ),
			'checkoutStarted'         => $checkout_started,
			'ordersCompleted'         => $orders_completed,
			'ordersRefunded'          => $this->shop_order_event_count( 'order_refunded', $from, $to ),
			'checkoutConversionRate'  => self::ratio( $orders_completed, $checkout_started ),
		];
	}

	private function shop_order_event_count( string $event_type, string $from, string $to ): int {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_events e
				WHERE e.event_type = %s AND e.created_at BETWEEN %s AND %s
				AND e.entity_id NOT IN (SELECT wc_order_id FROM {$wpdb->prefix}bc_bookings WHERE wc_order_id IS NOT NULL)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$start,
				$end
			)
		);
	}

	/**
	 * Search — source: wp_bc_events 'search_performed', added by this step
	 * directly inside MarketplaceController::browse() (the platform's real
	 * search/discovery entry point today; there is no separate free-text
	 * search endpoint — MKT-02 in the gap register already documents that
	 * as a distinct, deferred gap, not something this step invents).
	 * Deliberately does not store or expose raw query text — only bounded,
	 * privacy-safe counts and filter-usage booleans (§9/§22's own "avoid
	 * logging raw sensitive search text" instruction).
	 */
	public function search( string $from, string $to ): array {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );

		$total       = $this->count_events( 'search_performed', $from, $to );
		$zero_result = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'search_performed' AND created_at BETWEEN %s AND %s AND CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.resultCount')) AS UNSIGNED) = 0", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$start,
				$end
			)
		);

		return [
			'totalSearches'        => $total,
			'uniqueSearchers'      => $this->count_distinct_actors( 'search_performed', $from, $to ),
			'zeroResultSearches'   => $zero_result,
			'zeroResultRate'       => self::ratio( $zero_result, $total ),
			'specialtyFilterUsage' => $this->count_meta_bool_true( 'search_performed', 'specialtyFilter', $from, $to ),
			'locationFilterUsage'  => $this->count_meta_bool_true( 'search_performed', 'locationFilter', $from, $to ),
		];
	}

	/**
	 * AI — assistant-opened is a new UI-visibility event (POST /analytics/track,
	 * since the server can't otherwise observe a panel opening with no message
	 * sent yet); recommendation shown/clicked already existed before this step
	 * (beauclick-ai's AssistantService — see this step's own recon notes) and
	 * are only read here, not re-logged.
	 */
	public function ai( string $from, string $to ): array {
		$shown   = $this->count_events( 'ai_recommendation_shown', $from, $to );
		$clicked = $this->count_events( 'ai_recommendation_clicked', $from, $to );

		return [
			'assistantOpened'        => $this->count_events( 'ai_assistant_opened', $from, $to ),
			'recommendationsShown'   => $shown,
			'recommendationsClicked' => $clicked,
			'clickThroughRate'       => self::ratio( $clicked, $shown ),
		];
	}

	/**
	 * Retention — mostly reads from existing V2.1 Step 10 infrastructure
	 * rather than inventing new events for signals that already have an
	 * authoritative source (§7's own "event vs. database fact" instruction):
	 * waitlist status/matching comes from wp_bc_waitlist_entries, and
	 * notification delivery counts come from wp_bc_notifications (both
	 * already the real source of truth for those subsystems). The one new
	 * inference this method makes — "recoveredBookings" — is an explicit
	 * time-correlation approximation (a rebooking/retention notification was
	 * sent, and the same customer's next booking_created event followed
	 * within 14 days), NOT a verified click-through. It answers the real
	 * question this step exists to help answer ("do these systems actually
	 * cause more bookings?") as honestly as the data allows without a new
	 * click-tracking mechanism this step doesn't otherwise need.
	 */
	public function retention( string $from, string $to ): array {
		global $wpdb;
		[ $start, $end ] = self::bounds( $from, $to );

		$waitlist_cancelled = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_waitlist_entries WHERE status = 'cancelled' AND updated_at BETWEEN %s AND %s",
				$start,
				$end
			)
		);
		$waitlist_notified = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_waitlist_entries WHERE notified_at IS NOT NULL AND notified_at BETWEEN %s AND %s",
				$start,
				$end
			)
		);

		$notifications_by_category = [];
		foreach ( self::NOTIFICATION_CATEGORIES as $category ) {
			$notifications_by_category[ $category ] = (int) $wpdb->get_var(
				$wpdb->prepare(
					"SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE category = %s AND status = 'sent' AND sent_at BETWEEN %s AND %s",
					$category,
					$start,
					$end
				)
			);
		}

		$recovered_bookings = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(DISTINCT n.user_id) FROM {$wpdb->prefix}bc_notifications n
				JOIN {$wpdb->prefix}bc_events e ON e.event_type = 'booking_created' AND e.actor_id = n.user_id
					AND e.created_at > n.sent_at AND e.created_at <= DATE_ADD(n.sent_at, INTERVAL 14 DAY)
				WHERE n.category IN ('rebooking','retention') AND n.status = 'sent' AND n.sent_at BETWEEN %s AND %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$start,
				$end
			)
		);

		return [
			'waitlistJoined'           => $this->count_events( 'waitlist_joined', $from, $to ),
			'waitlistCancelled'        => $waitlist_cancelled,
			'waitlistOffersSent'       => $waitlist_notified,
			'notificationsSent'        => $notifications_by_category,
			'recoveredBookings'        => $recovered_bookings,
			'recoveredBookingsCaveat'  => 'همبستگی زمانی (نوبت جدید تا ۱۴ روز پس از اعلان)، نه ردیابی کلیک واقعی.',
		];
	}

	/**
	 * CRM/Journey usage — ANLYT-05. Both are new UI-visibility events (POST
	 * /analytics/track): opening a dashboard tab isn't a distinct REST call
	 * the server can reliably attribute to "the professional looked at their
	 * CRM" vs. any other authenticated request, so a lightweight, explicitly
	 * allow-listed client ping is the honest way to observe it (§25's own
	 * "use frontend events only when the server cannot reliably observe the
	 * interaction" rule). Loyalty/membership viewing is deliberately NOT a
	 * separate tracked event — LoyaltySection always renders as part of the
	 * Journey tab, not a distinct navigation destination, so a second ping
	 * there would just double-count the same tab visit.
	 */
	public function usage( string $from, string $to ): array {
		return [
			'crmOpened'     => $this->count_events( 'crm_opened', $from, $to ),
			'journeyOpened' => $this->count_events( 'journey_opened', $from, $to ),
		];
	}

	/**
	 * Marketplace — professional supply is a current snapshot (not
	 * range-bound; "how many professionals are live right now" doesn't have
	 * a meaningful date-range reading), profile views are range-bound and
	 * reuse the pre-existing profile_view event (V2.0 Step 1).
	 */
	public function marketplace( string $from, string $to ): array {
		global $wpdb;
		$professional_supply = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'bc_professional' AND post_status = 'publish'" // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		);

		return [
			'professionalSupply' => $professional_supply,
			'profileViews'       => $this->count_events( 'profile_view', $from, $to ),
		];
	}
}
