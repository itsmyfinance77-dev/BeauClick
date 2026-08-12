<?php
declare( strict_types=1 );

namespace BeauClick\Journey;

use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Profile\BeautyProfileService;

/**
 * Composes the single "خلاصه مسیر زیبایی" overview the dashboard's summary
 * screen needs in one request, instead of five-plus separate round trips
 * (the task's own explicit "avoid building the journey from dozens of
 * independent queries on every page load" performance instruction). Every
 * field is read fresh from its owning system's existing table/service --
 * bookings from beauclick-booking's own wp_bc_bookings, loyalty from
 * beauclick-loyalty's own LoyaltyLedger, recommendations from
 * beauclick-ai's own AssistantService -- nothing here is duplicated
 * storage, only a read-time composition.
 */
final class JourneySummaryService {

	private const UPCOMING_LIMIT  = 3;
	private const COMPLETED_LIMIT = 3;

	public function __construct(
		private readonly BeautyProfileService $profiles = new BeautyProfileService(),
		private readonly GoalService $goals = new GoalService()
	) {
	}

	/** @return array<string, mixed> */
	public function for_user( int $userId ): array {
		return [
			'profile'                => $this->profiles->get( $userId ),
			'activeGoals'            => $this->goals->for_user( $userId, 'active' ),
			'upcomingBookings'       => $this->upcoming_bookings( $userId ),
			'recentCompletedServices' => $this->recent_completed_bookings( $userId ),
			'loyaltyBalance'         => $this->loyalty_balance( $userId ),
			'recentRecommendations'  => $this->recent_ai_recommendations( $userId ),
			'memberSince'            => $this->member_since( $userId ),
		];
	}

	/** @return array<int, array<string, mixed>> */
	private function upcoming_bookings( int $userId ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d AND status = 'confirmed' AND slot_start > %s ORDER BY slot_start ASC LIMIT %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$userId,
				current_time( 'mysql' ),
				self::UPCOMING_LIMIT
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format_booking' ], $rows ?: [] );
	}

	/** @return array<int, array<string, mixed>> */
	private function recent_completed_bookings( int $userId ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d AND status = 'completed' ORDER BY slot_start DESC LIMIT %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$userId,
				self::COMPLETED_LIMIT
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format_booking' ], $rows ?: [] );
	}

	private function format_booking( array $row ): array {
		$provider_id   = (int) $row['provider_id'];
		$provider_post = get_post( $provider_id );
		$service_id    = $row['service_id'] ? (int) $row['service_id'] : null;

		return [
			'id'           => (int) $row['id'],
			'providerId'   => $provider_id,
			'providerName' => $provider_post ? $provider_post->post_title : '',
			'serviceId'    => $service_id,
			'serviceName'  => $service_id ? get_the_title( $service_id ) : null,
			'slotStart'    => $row['slot_start'],
			'status'       => $row['status'],
		];
	}

	private function loyalty_balance( int $userId ): ?int {
		if ( ! function_exists( 'beauclick_loyalty' ) || ! class_exists( \BeauClick\Loyalty\LoyaltyLedger::class ) ) {
			return null;
		}
		return ( new \BeauClick\Loyalty\LoyaltyLedger() )->balance( $userId );
	}

	/**
	 * Reuses AssistantService's own already-enriched, already-validated
	 * recommendation cards (get_or_create_conversation()/messages() are
	 * both public, existing methods) instead of re-deriving anything --
	 * Beauty Journey never generates a recommendation of its own, exactly
	 * per the task's "AI module should remain responsible for
	 * recommendation reasoning" boundary.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function recent_ai_recommendations( int $userId ): array {
		if ( ! class_exists( \BeauClick\AI\AssistantService::class ) ) {
			return [];
		}

		$service      = new \BeauClick\AI\AssistantService();
		$conversation = $service->get_or_create_conversation( $userId );
		$messages     = $service->messages( $conversation['id'], 20 );

		for ( $i = count( $messages ) - 1; $i >= 0; $i-- ) {
			if ( ! $messages[ $i ]['senderId'] && ! empty( $messages[ $i ]['recommendations'] ) ) {
				return $messages[ $i ]['recommendations'];
			}
		}
		return [];
	}

	private function member_since( int $userId ): ?string {
		$user = get_userdata( $userId );
		return $user ? $user->user_registered : null;
	}
}
