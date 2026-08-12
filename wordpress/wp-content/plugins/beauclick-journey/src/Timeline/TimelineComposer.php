<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Timeline;

/**
 * Composes a customer's journey timeline from data that already exists —
 * wp_bc_events (goal_created, review_submitted, order_completed/_refunded,
 * ai_recommendation_clicked -- all actor_id-scoped to the customer) and
 * wp_bc_bookings (booking_created/_confirmed/_completed/_cancelled events
 * are logged with entity_type='booking', NOT actor_id=customer -- see this
 * class's own note below) -- never a second, duplicated record of any of
 * these. No new table exists for the timeline itself.
 *
 * A real inconsistency found during implementation, same class of finding
 * as V2.0 Step 3's ranking work: BookingService::transition() (which logs
 * booking_confirmed/_completed) and cancel_booking() (booking_cancelled)
 * both log with entity_type='booking', entity_id=$booking_id, and no
 * actor_id at all -- so these three event types can't be filtered by
 * actor_id=customer the way goal_created/review_submitted/order_* can. This
 * class resolves it by first fetching the customer's own booking ids (their
 * own table, already indexed on customer_id) and matching events against
 * that id set instead.
 */
final class TimelineComposer {

	/**
	 * Event types considered meaningful journey milestones. Deliberately
	 * excludes profile_view (passive browsing, not a milestone),
	 * ai_recommendation_shown (fires on every AI turn -- too noisy), and
	 * booking_expired (an operational cleanup event, not something the
	 * customer did).
	 */
	private const RELEVANT_EVENT_TYPES = [
		'goal_created',
		'booking_created',
		'booking_confirmed',
		'booking_completed',
		'booking_cancelled',
		'review_submitted',
		'order_completed',
		'order_refunded',
		'ai_recommendation_clicked',
	];

	private const LABELS = [
		'goal_created'              => 'هدف زیبایی تعریف شد',
		'booking_created'           => 'رزرو ثبت شد',
		'booking_confirmed'         => 'رزرو تأیید شد',
		'booking_completed'         => 'خدمت انجام شد',
		'booking_cancelled'         => 'رزرو لغو شد',
		'review_submitted'          => 'نظر ثبت شد',
		'order_completed'           => 'خرید انجام شد',
		'order_refunded'            => 'سفارش مسترد شد',
		'ai_recommendation_clicked' => 'پیشنهاد دستیار هوشمند دنبال شد',
	];

	/** @return array<int, array<string, mixed>> */
	public function for_user( int $userId, int $limit = 20, int $offset = 0 ): array {
		global $wpdb;

		$booking_ids = $wpdb->get_col(
			$wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d", $userId ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		$booking_ids = array_map( 'intval', $booking_ids );

		$type_placeholders = implode( ',', array_fill( 0, count( self::RELEVANT_EVENT_TYPES ), '%s' ) );
		$params             = self::RELEVANT_EVENT_TYPES;

		$where = '(actor_id = %d)';
		$params[] = $userId;

		if ( $booking_ids ) {
			$booking_placeholders = implode( ',', array_fill( 0, count( $booking_ids ), '%d' ) );
			$where                .= " OR (entity_type = 'booking' AND entity_id IN ({$booking_placeholders}))";
			$params                = array_merge( $params, $booking_ids );
		}

		$sql = "SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type IN ({$type_placeholders}) AND ({$where}) ORDER BY created_at DESC LIMIT %d OFFSET %d"; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$params[] = $limit;
		$params[] = $offset;

		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	private function format( array $row ): array {
		$meta = $row['meta'] ? (array) json_decode( (string) $row['meta'], true ) : [];

		return [
			'type'      => $row['event_type'],
			'label'     => self::LABELS[ $row['event_type'] ] ?? $row['event_type'],
			'entityType' => $row['entity_type'],
			'entityId'  => (int) $row['entity_id'],
			'meta'      => $meta,
			'createdAt' => $row['created_at'],
		];
	}
}
