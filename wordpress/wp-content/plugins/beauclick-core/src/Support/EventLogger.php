<?php
declare( strict_types=1 );

namespace BeauClick\Core\Support;

/**
 * Thin writer for wp_bc_events. Every module logs through this rather than
 * writing to the table directly, so the event shape (and any future
 * validation/throttling) stays in one place.
 *
 * Known event_type values in use across modules (documented here since the
 * table has no schema-level enum): profile_view, booking_created,
 * booking_confirmed, booking_cancelled, booking_completed, booking_expired,
 * response_time_seconds, message_sent, review_submitted,
 * ai_recommendation_shown, ai_recommendation_clicked, b2b_account_applied,
 * b2b_account_{status}, b2b_quote_requested, b2b_quote_accepted,
 * booking_confirm_after_expiry_conflict, order_completed, order_refunded,
 * goal_created (V2.0 Step 4, entity_type='goal', actor_id=the customer),
 * booking_reschedule_requested, booking_reschedule_succeeded,
 * booking_reschedule_failed (V2.2 Step 15, entity_type='booking').
 *
 * A production-readiness pass found booking_created/_confirmed/_cancelled/
 * _completed, review_submitted, message_sent, and the AI/B2B events already
 * wired up in their respective services (BookingService, ReviewService,
 * ConversationService, AssistantService, BusinessAccountService/
 * QuoteService) — an earlier planning pass had incorrectly assumed these
 * were unwired; only profile_view, order_completed, and order_refunded were
 * genuinely missing and added in V2.0 Step 1.
 */
final class EventLogger {

	public function log( string $event_type, string $entity_type, int $entity_id, ?int $actor_id = null, array $meta = [] ): void {
		global $wpdb;

		$wpdb->insert(
			$wpdb->prefix . 'bc_events',
			[
				'event_type'  => $event_type,
				'entity_type' => $entity_type,
				'entity_id'   => $entity_id,
				'actor_id'    => $actor_id,
				'meta'        => ! empty( $meta ) ? wp_json_encode( $meta ) : null,
				'created_at'  => current_time( 'mysql' ),
			],
			[ '%s', '%s', '%d', '%d', '%s', '%s' ]
		);
	}

	/**
	 * V2.0 Step 1: a guard for the handful of call sites that react to a
	 * WooCommerce hook without an atomic status-transition guard of their
	 * own (order_completed/order_refunded — see beauclick-payments\Plugin).
	 * Most events here (booking_*, review_submitted) don't need this: they
	 * already log from inside an atomic status transition that itself only
	 * ever succeeds once per real state change, so a second call is a no-op
	 * before it ever reaches log(). profile_view intentionally has no such
	 * guard — every page view is a genuine, distinct event, not a duplicate
	 * to suppress.
	 */
	public function has_logged( string $event_type, string $entity_type, int $entity_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_type = %s AND entity_id = %d LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$entity_type,
				$entity_id
			)
		);
	}
}
