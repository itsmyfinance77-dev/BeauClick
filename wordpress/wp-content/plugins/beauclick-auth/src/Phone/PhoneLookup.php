<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Phone;

/**
 * V2.2 Step 14 — the one place another plugin (beauclick-privacy, for the
 * account-deletion OTP confirmation step) needs "what is this already-
 * logged-in user's own verified phone number," without reaching into
 * wp_bc_phone_index directly itself.
 */
final class PhoneLookup {

	public static function for_user( int $user_id ): ?string {
		global $wpdb;
		$phone = $wpdb->get_var(
			$wpdb->prepare( "SELECT phone_canonical FROM {$wpdb->prefix}bc_phone_index WHERE user_id = %d", $user_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		return $phone ?: null;
	}
}
