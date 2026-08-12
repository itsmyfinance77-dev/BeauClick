<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Ranking;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * Gathers raw RankingSignals per provider from the four places real ranking
 * data actually lives: this plugin's own wp_bc_bookings (completion/
 * conversion), beauclick-core's wp_bc_events (response time, profile views,
 * recent activity), beauclick-marketplace's wp_bc_provider_index (rating/
 * verified — already denormalized there, never read from wp_bc_reviews
 * directly), and each provider's own WP post/postmeta/taxonomy data
 * (profile completeness).
 *
 * This class lives in beauclick-booking, not beauclick-marketplace, because
 * of a real discrepancy found during implementation: the architecture doc's
 * §4.9 assumed a scoring job could read booking-outcome signals purely from
 * wp_bc_events, but booking_completed/_cancelled/_confirmed events are
 * logged with entity_type='booking' (entity_id = the booking id), not
 * entity_type='provider' -- there is no way to aggregate "completed bookings
 * per provider" from wp_bc_events alone without joining back through
 * wp_bc_bookings.provider_id. Reading wp_bc_bookings directly is only free
 * of cross-plugin-table coupling if this code lives inside beauclick-booking
 * itself, which is also where DashboardController already establishes the
 * precedent of a booking-plugin class reading marketplace's
 * wp_bc_provider_index directly (see that class's own docblock: "booking
 * already depends on marketplace... keeping the one-directional module
 * dependency chain intact"). Two provider-scoped event types (
 * response_time_seconds, review_submitted) DO use entity_type='provider'
 * correctly and are read from wp_bc_events as intended; profile_view is a
 * third, real inconsistency -- it logs entity_type as the CPT post type
 * (bc_professional/bc_business) rather than the literal 'provider' string
 * the others use, handled explicitly below rather than "fixed" (changing
 * existing V1 event-logging shape is out of scope per the V1 protection
 * rule -- this isn't a security/data-integrity/functional bug).
 */
final class SignalCollector {

	/** @return array<string, RankingSignals> keyed by "{provider_id}:{provider_type}" */
	public function collect_all(): array {
		global $wpdb;

		$index_rows = $wpdb->get_results(
			"SELECT provider_id, provider_type, rating_avg, review_count, verified FROM {$wpdb->prefix}bc_provider_index",
			ARRAY_A
		);
		if ( ! $index_rows ) {
			return [];
		}

		$lookback_start = gmdate( 'Y-m-d H:i:s', time() - RankingConfig::LOOKBACK_DAYS * DAY_IN_SECONDS );
		$recent_start   = gmdate( 'Y-m-d H:i:s', time() - RankingConfig::RECENT_ACTIVITY_DAYS * DAY_IN_SECONDS );

		$bookings_table = $wpdb->prefix . 'bc_bookings';
		$completed      = $this->group_count( "SELECT provider_id, COUNT(*) c FROM {$bookings_table} WHERE status = 'completed' AND created_at >= %s GROUP BY provider_id", $lookback_start );
		$cancelled      = $this->group_count( "SELECT provider_id, COUNT(*) c FROM {$bookings_table} WHERE status = 'cancelled' AND created_at >= %s GROUP BY provider_id", $lookback_start );
		$created_window = $this->group_count( "SELECT provider_id, COUNT(*) c FROM {$bookings_table} WHERE created_at >= %s GROUP BY provider_id", $lookback_start );
		$created_recent = $this->group_count( "SELECT provider_id, COUNT(*) c FROM {$bookings_table} WHERE created_at >= %s GROUP BY provider_id", $recent_start );

		$response_map  = $this->response_time_map( $lookback_start );
		$review_recent = $this->events_group_count( 'review_submitted', 'provider', $recent_start );
		$views_pro     = $this->events_group_count( 'profile_view', Registrar::PROFESSIONAL, $lookback_start );
		$views_biz     = $this->events_group_count( 'profile_view', Registrar::BUSINESS, $lookback_start );

		$signals = [];
		foreach ( $index_rows as $row ) {
			$id      = (int) $row['provider_id'];
			$type    = (string) $row['provider_type'];
			$views   = Registrar::BUSINESS === $type ? ( $views_biz[ $id ] ?? 0 ) : ( $views_pro[ $id ] ?? 0 );
			$signals[ "{$id}:{$type}" ] = new RankingSignals(
				ratingAvg: (float) $row['rating_avg'],
				reviewCount: (int) $row['review_count'],
				verified: (bool) $row['verified'],
				completedBookings: $completed[ $id ] ?? 0,
				cancelledBookings: $cancelled[ $id ] ?? 0,
				totalBookingsCreated: $created_window[ $id ] ?? 0,
				avgResponseSeconds: $response_map[ $id ] ?? null,
				profileViews: $views,
				profileCompleteness: $this->profile_completeness( $id ),
				recentActivityCount: ( $created_recent[ $id ] ?? 0 ) + ( $review_recent[ $id ] ?? 0 )
			);
		}
		return $signals;
	}

	public function collect_one( int $providerId, string $providerType ): ?RankingSignals {
		global $wpdb;

		$index_row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT rating_avg, review_count, verified FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d AND provider_type = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$providerId,
				$providerType
			),
			ARRAY_A
		);
		if ( ! $index_row ) {
			return null;
		}

		$lookback_start = gmdate( 'Y-m-d H:i:s', time() - RankingConfig::LOOKBACK_DAYS * DAY_IN_SECONDS );
		$recent_start   = gmdate( 'Y-m-d H:i:s', time() - RankingConfig::RECENT_ACTIVITY_DAYS * DAY_IN_SECONDS );

		$bookings_table = $wpdb->prefix . 'bc_bookings';
		$completed      = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$bookings_table} WHERE provider_id = %d AND status = 'completed' AND created_at >= %s", $providerId, $lookback_start ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$cancelled      = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$bookings_table} WHERE provider_id = %d AND status = 'cancelled' AND created_at >= %s", $providerId, $lookback_start ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$created_window = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$bookings_table} WHERE provider_id = %d AND created_at >= %s", $providerId, $lookback_start ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$created_recent = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$bookings_table} WHERE provider_id = %d AND created_at >= %s", $providerId, $recent_start ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		$events_table  = $wpdb->prefix . 'bc_events';
		$avg_response  = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT AVG(CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.seconds')) AS UNSIGNED)) FROM {$events_table} WHERE event_type = 'response_time_seconds' AND entity_type = 'provider' AND entity_id = %d AND created_at >= %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$providerId,
				$lookback_start
			)
		);
		$review_recent = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$events_table} WHERE event_type = 'review_submitted' AND entity_type = 'provider' AND entity_id = %d AND created_at >= %s", $providerId, $recent_start ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$views         = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$events_table} WHERE event_type = 'profile_view' AND entity_type = %s AND entity_id = %d AND created_at >= %s", $providerType, $providerId, $lookback_start ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return new RankingSignals(
			ratingAvg: (float) $index_row['rating_avg'],
			reviewCount: (int) $index_row['review_count'],
			verified: (bool) $index_row['verified'],
			completedBookings: $completed,
			cancelledBookings: $cancelled,
			totalBookingsCreated: $created_window,
			avgResponseSeconds: null !== $avg_response ? (int) round( (float) $avg_response ) : null,
			profileViews: $views,
			profileCompleteness: $this->profile_completeness( $providerId ),
			recentActivityCount: $created_recent + $review_recent
		);
	}

	/**
	 * The single average rating across every provider that has at least one
	 * review — the "m" (prior mean) in the Bayesian shrinkage formula.
	 * Falls back to RankingConfig::RATING_FALLBACK_MEAN only in a genuine
	 * cold-boot state (no reviews anywhere yet on the whole platform).
	 */
	public function platform_mean_rating(): float {
		global $wpdb;
		$mean = $wpdb->get_var( "SELECT AVG(rating_avg) FROM {$wpdb->prefix}bc_provider_index WHERE review_count > 0" );
		return null !== $mean ? (float) $mean : RankingConfig::RATING_FALLBACK_MEAN;
	}

	/**
	 * Four equally-weighted, cheaply-derivable components -- no new storage,
	 * everything already sits on the provider's own post. Deliberately
	 * simple booleans, not a "how good is this bio" quality judgment, which
	 * would be subjective and out of scope for a deterministic ranking
	 * signal.
	 */
	private function profile_completeness( int $providerId ): float {
		$post = get_post( $providerId );
		if ( ! $post ) {
			return 0.0;
		}

		$has_bio       = mb_strlen( trim( wp_strip_all_tags( $post->post_content ) ) ) >= 30;
		$has_thumbnail = has_post_thumbnail( $providerId );
		$has_portfolio = (bool) get_posts( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_parent' => $providerId, 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids' ] );
		$has_service   = (bool) get_posts( [ 'post_type' => Registrar::SERVICE, 'post_parent' => $providerId, 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids' ] );

		$components = [ $has_bio, $has_thumbnail, $has_portfolio, $has_service ];
		return count( array_filter( $components ) ) / count( $components );
	}

	/** @return array<int, int> provider_id => count */
	private function group_count( string $sql, string ...$params ): array {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$map  = [];
		foreach ( $rows ?: [] as $row ) {
			$map[ (int) $row['provider_id'] ] = (int) $row['c'];
		}
		return $map;
	}

	/** @return array<int, int> entity_id => count */
	private function events_group_count( string $eventType, string $entityType, string $since ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT entity_id, COUNT(*) c FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_type = %s AND created_at >= %s GROUP BY entity_id", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$eventType,
				$entityType,
				$since
			),
			ARRAY_A
		);
		$map = [];
		foreach ( $rows ?: [] as $row ) {
			$map[ (int) $row['entity_id'] ] = (int) $row['c'];
		}
		return $map;
	}

	/** @return array<int, int> entity_id => average seconds (rounded) */
	private function response_time_map( string $since ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT entity_id, AVG(CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.seconds')) AS UNSIGNED)) avg_s FROM {$wpdb->prefix}bc_events WHERE event_type = 'response_time_seconds' AND entity_type = 'provider' AND created_at >= %s GROUP BY entity_id", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$since
			),
			ARRAY_A
		);
		$map = [];
		foreach ( $rows ?: [] as $row ) {
			$map[ (int) $row['entity_id'] ] = (int) round( (float) $row['avg_s'] );
		}
		return $map;
	}
}
