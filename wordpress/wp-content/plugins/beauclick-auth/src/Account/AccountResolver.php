<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Account;

/**
 * Turns a verified canonical phone number into a WP user id -- the one
 * place that decides "is this an existing account or a brand new one,"
 * and the one place responsible for never silently merging two accounts
 * that might not actually be the same person.
 *
 * Three real cases, found by inspecting the actual current data rather
 * than assumed:
 * 1. The phone already has a wp_bc_phone_index row (a user who has
 *    completed this OTP flow before, whether by registering fresh or by
 *    being linked the first time under case 2) -- authenticate them.
 * 2. No phone_index row, but exactly one existing user's WooCommerce
 *    _billing_phone normalizes to this same canonical number (a real
 *    pre-auth-system account -- created via wp-cli seeding or via a real
 *    checkout's billing address in every prior V1/V2 session) -- link it
 *    (write the phone_index row) rather than creating a duplicate, then
 *    authenticate that same, real, pre-existing account. This is what
 *    lets `bc_qa_customer`'s real bookings/reviews/journey/loyalty data
 *    keep working the first time that account signs in through this flow.
 * 3. Multiple existing accounts' billing phones normalize to the same
 *    number -- a genuine data conflict this class must never guess its
 *    way through. Recorded in wp_bc_phone_conflicts for a human to
 *    resolve, and a brand new account is created rather than picking one
 *    at random -- the safe default, matching this codebase's own
 *    standing "do not silently merge users" instruction.
 */
final class AccountResolver {

	/** @return array{userId: int, isNew: bool} */
	public function find_or_create_for_phone( string $phone_canonical ): array {
		global $wpdb;

		$existing_user_id = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", $phone_canonical ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( $existing_user_id ) {
			return [ 'userId' => $existing_user_id, 'isNew' => false ];
		}

		$candidates = $this->find_unlinked_users_by_billing_phone( $phone_canonical );

		if ( count( $candidates ) === 1 ) {
			$this->link_phone( $candidates[0], $phone_canonical );
			return [ 'userId' => $candidates[0], 'isNew' => false ];
		}

		if ( count( $candidates ) > 1 ) {
			$this->record_conflict( $phone_canonical, $candidates );
			// Fall through to case 3 -- never guess which existing account is
			// the real owner; a brand new account is the safe default.
		}

		$user_id = $this->create_customer( $phone_canonical );
		$this->link_phone( $user_id, $phone_canonical );

		return [ 'userId' => $user_id, 'isNew' => true ];
	}

	/**
	 * Every WP user whose stored _billing_phone normalizes to
	 * $phone_canonical AND who has no phone_index row of their own yet
	 * (excluding anyone already linked to a *different* number, so this
	 * never reassigns an already-verified account's phone).
	 *
	 * @return int[]
	 */
	private function find_unlinked_users_by_billing_phone( string $phone_canonical ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT user_id, meta_value FROM {$wpdb->usermeta} WHERE meta_key = '_billing_phone' AND meta_value != ''", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		$matches = [];
		foreach ( $rows as $row ) {
			if ( \BeauClick\Auth\Phone\PhoneNormalizer::normalize( (string) $row['meta_value'] ) === $phone_canonical ) {
				$matches[] = (int) $row['user_id'];
			}
		}

		if ( ! $matches ) {
			return [];
		}

		$already_linked = $wpdb->get_col(
			$wpdb->prepare(
				'SELECT user_id FROM ' . $wpdb->prefix . 'bc_phone_index WHERE user_id IN (' . implode( ',', array_fill( 0, count( $matches ), '%d' ) ) . ')', // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$matches
			)
		);

		return array_values( array_diff( $matches, array_map( 'intval', $already_linked ) ) );
	}

	private function link_phone( int $user_id, string $phone_canonical ): void {
		global $wpdb;
		$now = current_time( 'mysql' );
		$wpdb->replace(
			$wpdb->prefix . 'bc_phone_index',
			[ 'user_id' => $user_id, 'phone_canonical' => $phone_canonical, 'verified_at' => $now, 'created_at' => $now ],
			[ '%d', '%s', '%s', '%s' ]
		);
	}

	private function record_conflict( string $phone_canonical, array $candidate_user_ids ): void {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_phone_conflicts',
			[
				'phone_canonical'    => $phone_canonical,
				'candidate_user_ids' => wp_json_encode( $candidate_user_ids ),
				'detected_at'        => current_time( 'mysql' ),
			],
			[ '%s', '%s', '%s' ]
		);
	}

	/** New WP user for a phone nobody has an account for yet -- WooCommerce's own `customer` role (with a `subscriber` fallback), matching RoleManager's own established "extend Woo's role, don't invent a duplicate" convention. No email is required (phone is the primary identifier); WordPress requires a unique, non-empty user_email internally, so a deterministic, clearly-synthetic placeholder is used until the customer supplies a real one (see PROF onboarding). */
	private function create_customer( string $phone_canonical ): int {
		$local_digits    = substr( $phone_canonical, 3 ); // "+989121234567" -> "9121234567", drop the '+98'
		$login           = 'bc_' . $local_digits;
		$placeholder_mail = $local_digits . '@phone.beauclick.local';

		$user_id = wp_insert_user(
			[
				'user_login'   => $login,
				'user_pass'    => wp_generate_password( 32 ),
				'user_email'   => $placeholder_mail,
				'display_name' => \BeauClick\Auth\Phone\PhoneNormalizer::masked( $phone_canonical ),
				'role'         => get_role( 'customer' ) ? 'customer' : 'subscriber',
			]
		);

		if ( is_wp_error( $user_id ) ) {
			throw new \RuntimeException( 'BeauClick Auth: failed to create user for a verified phone -- ' . $user_id->get_error_message() );
		}

		update_user_meta( (int) $user_id, '_billing_phone', '0' . $local_digits );

		return (int) $user_id;
	}
}
