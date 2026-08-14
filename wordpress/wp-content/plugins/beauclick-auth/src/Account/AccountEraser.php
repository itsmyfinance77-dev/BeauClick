<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Account;

/**
 * V2.2 Step 14 — anonymizes (never hard-deletes) the one WP user row every
 * other BeauClick domain resolves identity through. Deliberately a soft
 * anonymization, not `wp_delete_user()`:
 *
 * - Every other domain's own display code already calls `get_userdata()`/
 *   `get_user_by()` and already handles a user gracefully going missing (the
 *   `$user ? $user->display_name : '#' . $id` pattern used throughout the
 *   admin pages) — but a genuinely DELETED row would also silently break
 *   every place that still legitimately needs to resolve *something* for a
 *   retained record (a professional's own CRM note about this customer, a
 *   review this customer wrote, a booking they made) — anonymizing keeps
 *   `get_userdata($id)` resolving to a real (just-scrubbed) user for the
 *   entire lifetime of every retained record, with zero changes needed
 *   anywhere else in the codebase to keep displaying those correctly.
 * - The numeric `wp_users.ID` never changes, so every other table's
 *   `customer_id`/`user_id`/`author_id`/`actor_id` foreign-key-style column
 *   keeps pointing at a real (if now-anonymous) row.
 *
 * `forget()` is idempotent — checked via the `_bc_account_deleted` meta
 * flag — so it's safe to call again if a resumable deletion sweep (see
 * beauclick-privacy) retries after a partial failure elsewhere.
 */
final class AccountEraser {

	public const DELETED_FLAG_META = '_bc_account_deleted';
	public const DELETED_AT_META   = '_bc_account_deleted_at';

	public function is_forgotten( int $user_id ): bool {
		return (bool) get_user_meta( $user_id, self::DELETED_FLAG_META, true );
	}

	/**
	 * Scrubs every piece of directly-identifying data this plugin itself
	 * owns (auth identity, phone linkage) plus the standard WordPress/
	 * WooCommerce user fields every other domain's display code already
	 * reads via `get_userdata()`. Does NOT touch any other plugin's own
	 * tables — those are each domain's own responsibility (see
	 * beauclick-privacy's `DeletionService`, which calls this as one step
	 * among several).
	 */
	public function forget( int $user_id ): void {
		if ( $this->is_forgotten( $user_id ) ) {
			return; // Idempotent re-run after a partial failure elsewhere.
		}

		global $wpdb;

		$placeholder_email = 'deleted-user-' . $user_id . '@deleted.beauclick.local';

		wp_update_user(
			[
				'ID'           => $user_id,
				'display_name' => __( 'کاربر حذف‌شده', 'beauclick-auth' ),
				'first_name'   => '',
				'last_name'    => '',
				'user_email'   => $placeholder_email,
				'user_url'     => '',
			]
		);
		wp_set_password( wp_generate_password( 64, true, true ), $user_id );

		$user = get_userdata( $user_id );
		if ( $user ) {
			$user->set_role( '' ); // Strips every capability -- an anonymized account can no longer book/write reviews/etc. even if a login bypass ever occurred elsewhere.
		}

		foreach ( [ '_billing_phone', '_billing_email', '_billing_first_name', '_billing_last_name', '_billing_address_1', '_billing_address_2', '_billing_city', '_billing_postcode', '_shipping_phone', '_shipping_first_name', '_shipping_last_name', '_shipping_address_1', '_shipping_address_2', '_shipping_city', '_shipping_postcode' ] as $meta_key ) {
			delete_user_meta( $user_id, $meta_key );
		}

		// Frees the phone number for a genuine new registration -- per this
		// step's own explicit "deleted account + same phone must never
		// resurrect the old identity" requirement. AccountResolver's own
		// lookup order (phone_index first, then unlinked _billing_phone scan,
		// both now empty for this number) guarantees the next OTP login with
		// this number creates a brand-new account, never this one.
		$wpdb->delete( $wpdb->prefix . 'bc_phone_index', [ 'user_id' => $user_id ], [ '%d' ] );

		// Historical OTP request rows tied to this user as the requester
		// (change-phone/account-deletion confirmations) -- security/audit
		// artifacts, not data the user has any ongoing interest in, and the
		// codes were already one-way-hashed and short-lived even before this.
		$wpdb->delete( $wpdb->prefix . 'bc_otp_requests', [ 'requester_user_id' => $user_id ], [ '%d' ] );

		update_user_meta( $user_id, self::DELETED_FLAG_META, 1 );
		update_user_meta( $user_id, self::DELETED_AT_META, current_time( 'mysql' ) );
	}
}
