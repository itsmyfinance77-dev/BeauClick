<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Waitlist;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * V2.1 Step 10 (BOOK-06) — real waitlist entries scoped to actual
 * bookable data only (§5's explicit "do not allow users to waitlist
 * nonexistent professionals/unpublished services/invalid dates"
 * instruction): every create() call validates the provider is a real,
 * published professional/business post, the service (if given) is real,
 * published, and actually belongs to that provider, and the preferred
 * date is today or later.
 *
 * Deliberately does NOT reserve or lock anything — a waitlist entry is
 * pure customer intent. The existing booking engine
 * (`BookingService::create_booking()`) remains the sole source of truth
 * for who actually gets a slot; see `WaitlistMatcher` for how a
 * newly-opened slot is only ever *offered*, never pre-claimed.
 */
final class WaitlistService {

	public const STATUS_WAITING   = 'waiting';
	public const STATUS_CANCELLED = 'cancelled';
	public const STATUS_EXPIRED   = 'expired';

	/** No preferred_date given -- expires after this many days rather than living forever. */
	private const DEFAULT_EXPIRY_DAYS = 30;

	/** @return array{id:int}|string */
	public function create( int $customer_id, int $provider_id, ?int $service_id, ?string $preferred_date, ?string $time_start, ?string $time_end ) {
		$provider = get_post( $provider_id );
		if ( ! $provider || ! in_array( $provider->post_type, [ Registrar::PROFESSIONAL, Registrar::BUSINESS ], true ) || 'publish' !== $provider->post_status ) {
			return __( 'این متخصص یا کسب‌وکار پیدا نشد.', 'beauclick-booking' );
		}

		if ( $service_id ) {
			$service = get_post( $service_id );
			if ( ! $service || Registrar::SERVICE !== $service->post_type || 'publish' !== $service->post_status || (int) $service->post_parent !== $provider_id ) {
				return __( 'این خدمت پیدا نشد.', 'beauclick-booking' );
			}
		}

		if ( $preferred_date ) {
			$today = current_time( 'Y-m-d' );
			if ( $preferred_date < $today ) {
				return __( 'تاریخ درخواستی نمی‌تواند در گذشته باشد.', 'beauclick-booking' );
			}
		}

		if ( $this->has_duplicate( $customer_id, $provider_id, $service_id, $preferred_date ) ) {
			return __( 'شما قبلاً برای این زمان در لیست انتظار ثبت‌نام کرده‌اید.', 'beauclick-booking' );
		}

		global $wpdb;
		$now     = current_time( 'mysql' );
		$expires = $preferred_date
			? "{$preferred_date} 23:59:59"
			: gmdate( 'Y-m-d H:i:s', strtotime( $now ) + self::DEFAULT_EXPIRY_DAYS * DAY_IN_SECONDS );

		$wpdb->insert(
			$wpdb->prefix . 'bc_waitlist_entries',
			[
				'customer_id'          => $customer_id,
				'provider_id'          => $provider_id,
				'service_id'           => $service_id,
				'preferred_date'       => $preferred_date,
				'preferred_time_start' => $time_start,
				'preferred_time_end'   => $time_end,
				'status'               => self::STATUS_WAITING,
				'expires_at'           => $expires,
				'created_at'           => $now,
				'updated_at'           => $now,
			],
			[ '%d', '%d', '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%s' ]
		);
		// Captured immediately -- events()->log() below runs its OWN
		// $wpdb->insert() into wp_bc_events, which would otherwise
		// silently overwrite $wpdb->insert_id before this method reads it
		// a second time (the exact bug this comment now documents having
		// been caught and fixed, matching the "capture insert_id once,
		// reuse the local variable" discipline BookingService::create_booking()
		// already follows).
		$entry_id = (int) $wpdb->insert_id;

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'waitlist_joined', 'waitlist_entry', $entry_id, $customer_id, [ 'provider_id' => $provider_id ] );
		}

		return [ 'id' => $entry_id ];
	}

	private function has_duplicate( int $customer_id, int $provider_id, ?int $service_id, ?string $preferred_date ): bool {
		global $wpdb;
		$sql    = "SELECT id FROM {$wpdb->prefix}bc_waitlist_entries WHERE customer_id = %d AND provider_id = %d AND status = %s";
		$params = [ $customer_id, $provider_id, self::STATUS_WAITING ];

		if ( $service_id ) {
			$sql     .= ' AND service_id = %d';
			$params[] = $service_id;
		} else {
			$sql .= ' AND service_id IS NULL';
		}

		if ( $preferred_date ) {
			$sql      .= ' AND preferred_date = %s';
			$params[]  = $preferred_date;
		} else {
			$sql .= ' AND preferred_date IS NULL';
		}

		$sql .= ' LIMIT 1';

		return (bool) $wpdb->get_var( $wpdb->prepare( $sql, $params ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
	}

	/** @return array<int, array<string, mixed>> */
	public function for_user( int $customer_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_waitlist_entries WHERE customer_id = %d ORDER BY created_at DESC", $customer_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/** @return array<int, array<string, mixed>> */
	public function for_provider( int $provider_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_waitlist_entries WHERE provider_id = %d AND status = %s ORDER BY created_at ASC", $provider_id, self::STATUS_WAITING ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	public function find( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_waitlist_entries WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format( $row ) : null;
	}

	public function cancel( int $id ): bool {
		global $wpdb;
		$affected = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_waitlist_entries SET status = %s, updated_at = %s WHERE id = %d AND status = %s",
				self::STATUS_CANCELLED,
				current_time( 'mysql' ),
				$id,
				self::STATUS_WAITING
			)
		);
		return (bool) $affected;
	}

	/**
	 * @return list<array<string, mixed>> Waiting entries matching a
	 * just-opened slot -- same provider, and (if the entry specified one)
	 * the same service and/or exact preferred date. FIFO order
	 * (created_at ASC) is the priority rule (§7/§15) -- deterministic,
	 * no auction, no AI.
	 */
	public function matching( int $provider_id, ?int $service_id, string $slot_date ): array {
		global $wpdb;
		$sql    = "SELECT * FROM {$wpdb->prefix}bc_waitlist_entries
			WHERE provider_id = %d AND status = %s
			AND ( service_id IS NULL OR service_id = %d )
			AND ( preferred_date IS NULL OR preferred_date = %s )
			ORDER BY created_at ASC";
		$rows   = $wpdb->get_results( $wpdb->prepare( $sql, $provider_id, self::STATUS_WAITING, $service_id ?? 0, $slot_date ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	public function mark_notified( int $id ): void {
		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_waitlist_entries',
			[ 'notified_at' => current_time( 'mysql' ), 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $id ]
		);
	}

	/** Sweep: expires waiting entries past their expires_at. @return int Number expired. */
	public function expire_due(): int {
		global $wpdb;
		$affected = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_waitlist_entries SET status = %s, updated_at = %s WHERE status = %s AND expires_at IS NOT NULL AND expires_at < %s",
				self::STATUS_EXPIRED,
				current_time( 'mysql' ),
				self::STATUS_WAITING,
				current_time( 'mysql' )
			)
		);
		return (int) $affected;
	}

	private function format( array $row ): array {
		return [
			'id'                => (int) $row['id'],
			'customerId'        => (int) $row['customer_id'],
			'providerId'        => (int) $row['provider_id'],
			'serviceId'         => $row['service_id'] ? (int) $row['service_id'] : null,
			'preferredDate'     => $row['preferred_date'],
			'preferredTimeStart' => $row['preferred_time_start'],
			'preferredTimeEnd'  => $row['preferred_time_end'],
			'status'            => $row['status'],
			'notifiedAt'        => $row['notified_at'],
			'expiresAt'         => $row['expires_at'],
			'createdAt'         => $row['created_at'],
		];
	}
}
