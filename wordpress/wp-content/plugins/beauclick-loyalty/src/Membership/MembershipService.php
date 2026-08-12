<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Membership;

/**
 * V2.1 Step 9 — membership is real account STATE (active/expired/cancelled),
 * not a ledger: `wp_bc_memberships` holds at most one row per user
 * (`UNIQUE KEY user_id`), mutated in place as status changes, matching the
 * task's own "minimal persisted membership state" guidance rather than an
 * append-only history table. Every state change is still auditable -- it
 * goes through the existing `EventLogger` (`wp_bc_events`) instead of a
 * dedicated fifth table, reusing infrastructure this codebase already has.
 *
 * Deliberately kept separate from `TierService`: qualifying for a tier and
 * holding a membership are two different concepts (per the task's own
 * explicit "keep loyalty, membership, and coupons separate" instruction).
 * `TierMembershipSync` is the one place that bridges them, for
 * tier-LINKED plans only, and even then only ever auto-activates -- it
 * never auto-cancels a membership a customer already holds.
 */
final class MembershipService {

	public const STATUS_ACTIVE    = 'active';
	public const STATUS_EXPIRED   = 'expired';
	public const STATUS_CANCELLED = 'cancelled';

	/** @return array<string, mixed>|null */
	public function for_user( int $user_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_memberships WHERE user_id = %d", $user_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( ! $row ) {
			return null;
		}
		$plan = $this->find_plan( (int) $row['plan_id'] );
		return [
			'id'               => (int) $row['id'],
			'planId'           => (int) $row['plan_id'],
			'plan'             => $plan,
			'status'           => $row['status'],
			'activationSource' => $row['activation_source'],
			'startedAt'        => $row['started_at'],
			'expiresAt'        => $row['expires_at'],
		];
	}

	/** @return list<array<string, mixed>> */
	public function plans( bool $active_only = false ): array {
		global $wpdb;
		$where = $active_only ? 'WHERE is_active = 1' : '';
		$rows  = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_membership_plans {$where} ORDER BY sort_order ASC", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		return array_map( [ $this, 'format_plan' ], $rows ?: [] );
	}

	public function find_plan( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_membership_plans WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format_plan( $row ) : null;
	}

	/** @return array{id:int}|string */
	public function create_plan( string $slug, string $name, ?int $tier_id, bool $is_paid, ?int $price, ?int $billing_period_days, int $sort_order = 0 ) {
		if ( '' === trim( $slug ) || '' === trim( $name ) ) {
			return 'نام و شناسه پلن الزامی است.';
		}

		global $wpdb;
		$now    = current_time( 'mysql' );
		$result = $wpdb->insert(
			$wpdb->prefix . 'bc_membership_plans',
			[
				'slug'                => sanitize_key( $slug ),
				'name'                => $name,
				'tier_id'             => $tier_id,
				'is_paid'             => $is_paid ? 1 : 0,
				'price'               => $price,
				'billing_period_days' => $billing_period_days,
				'is_active'           => 1,
				'sort_order'          => $sort_order,
				'created_at'          => $now,
				'updated_at'          => $now,
			],
			[ '%s', '%s', '%d', '%d', '%d', '%d', '%d', '%d', '%s', '%s' ]
		);

		if ( ! $result ) {
			return 'این شناسه پلن قبلاً استفاده شده است.';
		}
		return [ 'id' => (int) $wpdb->insert_id ];
	}

	/** @param array<string, mixed> $fields */
	public function update_plan( int $id, array $fields ) {
		global $wpdb;
		$data   = [];
		$format = [];

		foreach ( [ 'name' => '%s' ] as $key => $fmt ) {
			if ( isset( $fields[ $key ] ) ) {
				$data[ $key ] = (string) $fields[ $key ];
				$format[]     = $fmt;
			}
		}
		if ( array_key_exists( 'tierId', $fields ) ) {
			$data['tier_id'] = $fields['tierId'] ? (int) $fields['tierId'] : null;
			$format[]        = '%d';
		}
		if ( isset( $fields['isPaid'] ) ) {
			$data['is_paid'] = ! empty( $fields['isPaid'] ) ? 1 : 0;
			$format[]        = '%d';
		}
		if ( array_key_exists( 'price', $fields ) ) {
			$data['price'] = null !== $fields['price'] ? (int) $fields['price'] : null;
			$format[]      = '%d';
		}
		if ( isset( $fields['isActive'] ) ) {
			$data['is_active'] = ! empty( $fields['isActive'] ) ? 1 : 0;
			$format[]          = '%d';
		}

		if ( $data ) {
			$data['updated_at'] = current_time( 'mysql' );
			$format[]            = '%s';
			$wpdb->update( $wpdb->prefix . 'bc_membership_plans', $data, [ 'id' => $id ], $format, [ '%d' ] );
		}
		return $this->find_plan( $id ) ?? 'پلن پیدا نشد.';
	}

	/**
	 * Idempotent: activating the same already-active plan for a user is a
	 * safe no-op re-write, never a duplicate row (UNIQUE KEY user_id makes a
	 * second row impossible even under a race -- this upserts instead of
	 * inserting blindly).
	 *
	 * @return array{id:int}|string
	 */
	public function activate( int $user_id, int $plan_id, string $source, ?int $actor_id = null ) {
		$plan = $this->find_plan( $plan_id );
		if ( ! $plan || ! $plan['isActive'] ) {
			return 'پلن عضویت پیدا نشد یا غیرفعال است.';
		}

		global $wpdb;
		$now     = current_time( 'mysql' );
		$expires = $plan['billingPeriodDays'] ? gmdate( 'Y-m-d H:i:s', strtotime( "+{$plan['billingPeriodDays']} days", strtotime( $now ) ) ) : null;

		$existing = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_memberships WHERE user_id = %d", $user_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		if ( $existing ) {
			$wpdb->update(
				$wpdb->prefix . 'bc_memberships',
				[
					'plan_id'           => $plan_id,
					'status'            => self::STATUS_ACTIVE,
					'activation_source' => $source,
					'started_at'        => $now,
					'expires_at'        => $expires,
					'updated_at'        => $now,
				],
				[ 'id' => $existing ]
			);
			$membership_id = (int) $existing;
		} else {
			$wpdb->insert(
				$wpdb->prefix . 'bc_memberships',
				[
					'user_id'           => $user_id,
					'plan_id'           => $plan_id,
					'status'            => self::STATUS_ACTIVE,
					'activation_source' => $source,
					'started_at'        => $now,
					'expires_at'        => $expires,
					'created_at'        => $now,
					'updated_at'        => $now,
				]
			);
			$membership_id = (int) $wpdb->insert_id;
		}

		$this->log( 'membership_activated', $membership_id, $user_id, $actor_id, [ 'planId' => $plan_id, 'source' => $source ] );
		return [ 'id' => $membership_id ];
	}

	public function cancel( int $user_id, ?int $actor_id = null ): bool|string {
		global $wpdb;
		$membership = $this->for_user( $user_id );
		if ( ! $membership || self::STATUS_ACTIVE !== $membership['status'] ) {
			return 'عضویت فعالی برای لغو وجود ندارد.';
		}

		$wpdb->update(
			$wpdb->prefix . 'bc_memberships',
			[ 'status' => self::STATUS_CANCELLED, 'updated_at' => current_time( 'mysql' ) ],
			[ 'user_id' => $user_id ]
		);

		$this->log( 'membership_cancelled', $membership['id'], $user_id, $actor_id );
		return true;
	}

	/** Sweep for a cron/manual trigger -- expires every active membership whose expires_at has passed. Never deletes the row (append-only status transition, matching the ledger convention). @return int Number expired. */
	public function expire_due(): int {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT id, user_id FROM {$wpdb->prefix}bc_memberships WHERE status = %s AND expires_at IS NOT NULL AND expires_at <= %s", self::STATUS_ACTIVE, current_time( 'mysql' ) ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		foreach ( $rows ?: [] as $row ) {
			$wpdb->update(
				$wpdb->prefix . 'bc_memberships',
				[ 'status' => self::STATUS_EXPIRED, 'updated_at' => current_time( 'mysql' ) ],
				[ 'id' => $row['id'] ]
			);
			$this->log( 'membership_expired', (int) $row['id'], (int) $row['user_id'], null );
		}

		return count( $rows ?: [] );
	}

	private function log( string $event_type, int $membership_id, int $user_id, ?int $actor_id, array $meta = [] ): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->events()->log( $event_type, 'membership', $membership_id, $actor_id, array_merge( [ 'userId' => $user_id ], $meta ) );
	}

	private function format_plan( array $row ): array {
		return [
			'id'                 => (int) $row['id'],
			'slug'               => $row['slug'],
			'name'               => $row['name'],
			'tierId'             => null !== $row['tier_id'] ? (int) $row['tier_id'] : null,
			'isPaid'             => (bool) $row['is_paid'],
			'price'              => null !== $row['price'] ? (int) $row['price'] : null,
			'billingPeriodDays'  => null !== $row['billing_period_days'] ? (int) $row['billing_period_days'] : null,
			'isActive'           => (bool) $row['is_active'],
			'sortOrder'          => (int) $row['sort_order'],
		];
	}
}
