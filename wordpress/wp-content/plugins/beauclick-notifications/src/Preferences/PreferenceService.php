<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Preferences;

/**
 * V2.1 Step 10 (NOTIF-06/PROF-02) -- per-category, opt-out preferences.
 * Absence of a row means "enabled": a customer who has never touched their
 * preferences still gets useful reminders/waitlist alerts/rebooking
 * suggestions by default, matching real product expectations, and the
 * table only ever grows to record an explicit *change* rather than a full
 * row per user on day one.
 *
 * `CATEGORY_BOOKING` (real booking confirm/cancel mail, sent by the
 * existing, untouched `BookingMailer`) is deliberately NOT part of this
 * preference system at all -- it is the "legally/operationally required
 * transactional message" the task explicitly says must never be
 * disableable, so there is no category key for it here and no code path
 * that could ever suppress it.
 */
final class PreferenceService {

	public const CATEGORY_REMINDER   = 'reminder';
	public const CATEGORY_WAITLIST   = 'waitlist';
	public const CATEGORY_REBOOKING  = 'rebooking';
	public const CATEGORY_RETENTION  = 'retention';

	public const CATEGORIES = [ self::CATEGORY_REMINDER, self::CATEGORY_WAITLIST, self::CATEGORY_REBOOKING, self::CATEGORY_RETENTION ];

	/** reminder/waitlist/rebooking are tied to something the customer explicitly did (booked, joined a waitlist, completed a visit) -- "transactional" in spirit though still user-togglable per the task's own §12 instruction. retention is the one genuinely unprompted, promotional category. */
	public const KIND_TRANSACTIONAL = 'transactional';
	public const KIND_PROMOTIONAL   = 'promotional';

	public function kind_of( string $category ): string {
		return self::CATEGORY_RETENTION === $category ? self::KIND_PROMOTIONAL : self::KIND_TRANSACTIONAL;
	}

	public function is_enabled( int $user_id, string $category ): bool {
		global $wpdb;
		$value = $wpdb->get_var(
			$wpdb->prepare( "SELECT enabled FROM {$wpdb->prefix}bc_notification_preferences WHERE user_id = %d AND category = %s", $user_id, $category ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		return null === $value ? true : (bool) $value; // No row -- default enabled (opt-out model).
	}

	/** @return array<string, bool> One entry per known category. */
	public function for_user( int $user_id ): array {
		$prefs = [];
		foreach ( self::CATEGORIES as $category ) {
			$prefs[ $category ] = $this->is_enabled( $user_id, $category );
		}
		return $prefs;
	}

	/** @param array<string, bool> $updates */
	public function update( int $user_id, array $updates ): array {
		global $wpdb;
		foreach ( $updates as $category => $enabled ) {
			if ( ! in_array( $category, self::CATEGORIES, true ) ) {
				continue; // Silently ignore an unknown/forged category key rather than erroring -- never lets a client write an arbitrary row.
			}
			$wpdb->query(
				$wpdb->prepare(
					"INSERT INTO {$wpdb->prefix}bc_notification_preferences (user_id, category, enabled, updated_at) VALUES (%d, %s, %d, %s)
					 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = VALUES(updated_at)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					$user_id,
					$category,
					$enabled ? 1 : 0,
					current_time( 'mysql' )
				)
			);
		}
		return $this->for_user( $user_id );
	}
}
