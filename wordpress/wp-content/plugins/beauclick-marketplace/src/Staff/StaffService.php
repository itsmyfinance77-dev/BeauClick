<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Staff;

/**
 * V2.2 Step 16 — a deliberately minimal multi-staff model: one flat 'staff'
 * role (the owner is implicit via the provider post's own post_author,
 * never a row in this table), added by phone number lookup against the
 * existing wp_bc_phone_index (beauclick-auth), never an email-invite flow.
 *
 * Scope boundary, stated explicitly per the task's own "if too large,
 * document the boundary and move it to V2.3" instruction: this step wires
 * staff resolution into exactly two surfaces — CRM (CrmController) and a
 * professional's own analytics (MyAnalyticsController) — not into booking
 * actions (confirm/cancel/reschedule) or review responses. Extending every
 * existing ownership check in the codebase to accept staff is a
 * meaningfully larger, higher-regression-risk change (it would touch
 * BookingController, ReceiptController, ReviewsController — each already
 * shipped and tested); left as a named, deliberate V2.3+ extension rather
 * than silently expanded here.
 */
final class StaffService {

	public const STATUS_ACTIVE = 'active';

	public const ERROR_NOT_FOUND      = 'not_found';
	public const ERROR_IS_OWNER       = 'is_owner';
	public const ERROR_ALREADY_STAFF  = 'already_staff';

	/**
	 * @return array{id:int}|string 'not_found'|'is_owner'|'already_staff' on failure.
	 */
	public function add( int $business_id, string $phone, int $added_by ) {
		if ( ! class_exists( '\BeauClick\Auth\Phone\PhoneNormalizer' ) ) {
			return self::ERROR_NOT_FOUND;
		}
		$canonical = \BeauClick\Auth\Phone\PhoneNormalizer::normalize( $phone );
		if ( ! $canonical ) {
			return self::ERROR_NOT_FOUND;
		}

		global $wpdb;
		$user_id = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", $canonical ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( ! $user_id ) {
			return self::ERROR_NOT_FOUND;
		}

		$provider = get_post( $business_id );
		if ( $provider && (int) $provider->post_author === $user_id ) {
			return self::ERROR_IS_OWNER;
		}

		if ( $this->is_active_staff( $business_id, $user_id ) ) {
			return self::ERROR_ALREADY_STAFF;
		}

		// A previously-removed ('removed') row for the same (business_id,
		// user_id) pair would collide with the UNIQUE key on a plain INSERT
		// -- upsert back to active instead of erroring on a legitimate
		// re-add.
		$wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$wpdb->prefix}bc_business_staff (business_id, user_id, role, status, added_by, created_at)
				 VALUES (%d, %d, 'staff', %s, %d, %s)
				 ON DUPLICATE KEY UPDATE status = VALUES(status), added_by = VALUES(added_by), created_at = VALUES(created_at)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$business_id,
				$user_id,
				self::STATUS_ACTIVE,
				$added_by,
				current_time( 'mysql' )
			)
		);

		return [ 'id' => $user_id ];
	}

	/**
	 * A soft removal (status='removed'), not a DELETE — matching this
	 * codebase's own established preference for an inspectable status
	 * change over silently erasing the row (WaitlistService::cancel()'s
	 * identical shape), and what makes add()'s ON DUPLICATE KEY UPDATE
	 * upsert path meaningful: re-adding a previously-removed staff member
	 * flips the same row back to active rather than colliding on the
	 * UNIQUE(business_id, user_id) key.
	 */
	public function remove( int $business_id, int $user_id ): bool {
		global $wpdb;
		$affected = $wpdb->update(
			$wpdb->prefix . 'bc_business_staff',
			[ 'status' => 'removed' ],
			[ 'business_id' => $business_id, 'user_id' => $user_id, 'status' => self::STATUS_ACTIVE ],
			[ '%s' ],
			[ '%d', '%d', '%s' ]
		);
		return (bool) $affected;
	}

	/** @return array<int, array<string, mixed>> */
	public function list_for_business( int $business_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT user_id, role, status, created_at FROM {$wpdb->prefix}bc_business_staff WHERE business_id = %d AND status = %s ORDER BY created_at ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$business_id,
				self::STATUS_ACTIVE
			),
			ARRAY_A
		);
		return array_map(
			static function ( array $r ): array {
				$user = get_userdata( (int) $r['user_id'] );
				return [
					'userId'    => (int) $r['user_id'],
					'name'      => $user ? $user->display_name : '',
					'email'     => $user ? $user->user_email : '',
					'role'      => $r['role'],
					'addedAt'   => $r['created_at'],
				];
			},
			$rows ?: []
		);
	}

	public function is_active_staff( int $business_id, int $user_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_business_staff WHERE business_id = %d AND user_id = %d AND status = %s LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$business_id,
				$user_id,
				self::STATUS_ACTIVE
			)
		);
	}

	/** @return list<int> Every business_id this user is an active staff member of. */
	public function provider_ids_for_staff_user( int $user_id ): array {
		global $wpdb;
		$ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT business_id FROM {$wpdb->prefix}bc_business_staff WHERE user_id = %d AND status = %s ORDER BY created_at ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$user_id,
				self::STATUS_ACTIVE
			)
		);
		return array_map( 'intval', $ids );
	}
}
