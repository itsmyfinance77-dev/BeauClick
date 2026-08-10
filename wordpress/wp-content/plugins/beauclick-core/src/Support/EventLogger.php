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
 * booking_confirmed, booking_cancelled, booking_completed, message_sent,
 * review_submitted, ai_recommendation_shown, ai_recommendation_clicked.
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
}
