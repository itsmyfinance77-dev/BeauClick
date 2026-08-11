<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Business;

/**
 * "B2B buyer" is a data fact (an approved row here), not a role — see the
 * migration's docblock. Every other module that needs to know "is this
 * user allowed to see wholesale pricing" calls is_approved(), never a
 * capability check.
 */
final class BusinessAccountService {

	public const STATUS_PENDING  = 'pending';
	public const STATUS_APPROVED = 'approved';
	public const STATUS_REJECTED = 'rejected';

	public function apply( int $user_id, string $business_name, ?string $license = null, ?string $phone = null ): int {
		global $wpdb;

		$existing = $this->find_by_user( $user_id );
		if ( $existing ) {
			return (int) $existing['id']; // Idempotent — re-applying doesn't create a duplicate row.
		}

		$now = current_time( 'mysql' );
		$wpdb->insert(
			$wpdb->prefix . 'bc_business_accounts',
			[
				'user_id'          => $user_id,
				'business_name'    => $business_name,
				'business_license' => $license,
				'contact_phone'    => $phone,
				'approval_status'  => self::STATUS_PENDING,
				'created_at'       => $now,
				'updated_at'       => $now,
			]
		);

		$id = $wpdb->insert_id;

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'b2b_account_applied', 'business_account', $id, $user_id );
		}

		return $id;
	}

	public function approve( int $account_id ): bool {
		return $this->set_status( $account_id, self::STATUS_APPROVED );
	}

	public function reject( int $account_id, string $reason = '' ): bool {
		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_business_accounts',
			[ 'approval_status' => self::STATUS_REJECTED, 'rejection_reason' => $reason, 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $account_id ]
		);
		return true;
	}

	private function set_status( int $account_id, string $status ): bool {
		global $wpdb;
		$updated = $wpdb->update(
			$wpdb->prefix . 'bc_business_accounts',
			[ 'approval_status' => $status, 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $account_id ]
		);

		if ( $updated && function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( "b2b_account_{$status}", 'business_account', $account_id );
		}

		return (bool) $updated;
	}

	public function find_by_user( int $user_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_business_accounts WHERE user_id = %d", $user_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	public function find( int $account_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_business_accounts WHERE id = %d", $account_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	public function is_approved( int $user_id ): bool {
		$account = $this->find_by_user( $user_id );
		return $account && self::STATUS_APPROVED === $account['approval_status'];
	}
}
