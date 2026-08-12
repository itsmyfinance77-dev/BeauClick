<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Crm;

/**
 * Read/aggregation layer over data that already exists (bookings, reviews,
 * conversations, users) plus the one genuinely new table this step adds
 * (wp_bc_crm_notes) — architecture doc §4.5's own framing for this
 * capability. Every method here is scoped by $provider_id, the
 * bc_professional/bc_business CPT post id a caller resolves via
 * ProviderLookup::for_user() before ever reaching this class; nothing here
 * trusts a caller-supplied customer id without first confirming a real
 * booking ties that customer to this exact provider (see is_customer_of()).
 *
 * list_customers() deliberately does its aggregation in a small, fixed
 * number of SQL queries (one per data source, each GROUP BY-ed or IN-ed
 * across the whole customer set) rather than one query per customer — the
 * same "bulk GROUP BY, not per-row" discipline V2.0 Step 3's
 * SignalCollector already established for ranking. Search/filter/pagination
 * then happen in PHP over that small, already-fetched result set: a single
 * provider's own customer list is bounded by that provider's own real
 * booking history (this project's own stated realistic scale — low
 * hundreds, not millions, of bookings per provider), so this is the
 * simplest-viable-architecture choice, not a shortcut that will need
 * revisiting at the scale this product actually operates at.
 */
final class CrmService {

	private const REVIEW_TARGET_TYPE = 'provider';

	/**
	 * @return array{items: array<int, array<string, mixed>>, total: int}
	 */
	public function list_customers( int $provider_id, string $search, string $filter, int $page, int $per_page ): array {
		global $wpdb;
		$bookings = $wpdb->prefix . 'bc_bookings';

		$now = current_time( 'mysql' );

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT
					customer_id,
					COUNT(*) AS total_bookings,
					SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
					MAX(CASE WHEN status = 'completed' THEN slot_start ELSE NULL END) AS last_visit,
					MIN(CASE WHEN status = 'confirmed' AND slot_start > %s THEN slot_start ELSE NULL END) AS next_booking,
					MIN(created_at) AS first_booking_at
				FROM {$bookings}
				WHERE provider_id = %d
				GROUP BY customer_id", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$now,
				$provider_id
			),
			ARRAY_A
		);

		if ( ! $rows ) {
			return [ 'items' => [], 'total' => 0 ];
		}

		$customer_ids = array_map( static fn( array $r ) => (int) $r['customer_id'], $rows );
		$users        = $this->users_by_id( $customer_ids );
		$phones       = $this->phones_by_id( $customer_ids );
		$reviews      = $this->review_summary_by_customer( $provider_id, $customer_ids );
		$notes_count  = $this->notes_count_by_customer( $provider_id, $customer_ids );

		$items = [];
		foreach ( $rows as $row ) {
			$customer_id = (int) $row['customer_id'];
			$user        = $users[ $customer_id ] ?? null;
			if ( ! $user ) {
				continue; // A deleted WP user can still own historical bookings; nothing sensible to show without an identity.
			}

			$items[] = [
				'customerId'     => $customer_id,
				'name'           => $user->display_name,
				'email'          => $user->user_email,
				'phone'          => $phones[ $customer_id ] ?? null,
				'totalBookings'  => (int) $row['total_bookings'],
				'completedCount' => (int) $row['completed_count'],
				'lastVisit'      => $row['last_visit'],
				'nextBooking'    => $row['next_booking'],
				'firstBookingAt' => $row['first_booking_at'],
				'reviewCount'    => $reviews[ $customer_id ]['count'] ?? 0,
				'notesCount'     => $notes_count[ $customer_id ] ?? 0,
			];
		}

		if ( $search !== '' ) {
			$needle = self::normalize_digits( mb_strtolower( $search ) );
			$items  = array_values(
				array_filter(
					$items,
					static function ( array $item ) use ( $needle ) {
						$haystack = self::normalize_digits( mb_strtolower( ( $item['name'] ?? '' ) . ' ' . ( $item['email'] ?? '' ) . ' ' . ( $item['phone'] ?? '' ) ) );
						return str_contains( $haystack, $needle );
					}
				)
			);
		}

		if ( $filter !== '' && $filter !== 'all' ) {
			$items = array_values( array_filter( $items, static fn( array $item ) => self::matches_filter( $item, $filter, $now ) ) );
		}

		// Most recently active customer first — the natural "who do I need to
		// think about" order for a professional scanning this list.
		usort(
			$items,
			static function ( array $a, array $b ) {
				return strcmp( (string) ( $b['lastVisit'] ?? $b['firstBookingAt'] ), (string) ( $a['lastVisit'] ?? $a['firstBookingAt'] ) );
			}
		);

		$total  = count( $items );
		$offset = ( $page - 1 ) * $per_page;
		$items  = array_slice( $items, $offset, $per_page );

		return [ 'items' => $items, 'total' => $total ];
	}

	private static function matches_filter( array $item, string $filter, string $now ): bool {
		return match ( $filter ) {
			'new'         => $item['completedCount'] === 0 && $item['totalBookings'] > 0,
			'returning'   => $item['completedCount'] >= 2,
			'upcoming'    => $item['nextBooking'] !== null,
			'has_review'  => $item['reviewCount'] > 0,
			'inactive'    => $item['nextBooking'] === null
				&& $item['lastVisit'] !== null
				&& strtotime( $item['lastVisit'] ) < strtotime( $now ) - 60 * DAY_IN_SECONDS,
			default       => true,
		};
	}

	/** Whether $customer_id is genuinely one of $provider_id's customers — the one real authorization boundary every detail/note endpoint must pass through. */
	public function is_customer_of( int $provider_id, int $customer_id ): bool {
		global $wpdb;
		$bookings = $wpdb->prefix . 'bc_bookings';
		return (bool) $wpdb->get_var(
			$wpdb->prepare( "SELECT 1 FROM {$bookings} WHERE provider_id = %d AND customer_id = %d LIMIT 1", $provider_id, $customer_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
	}

	/**
	 * @return array<string, mixed>|null Null only if is_customer_of() would also be false — callers must check ownership first regardless.
	 */
	public function get_customer_detail( int $provider_id, int $customer_id ): ?array {
		if ( ! $this->is_customer_of( $provider_id, $customer_id ) ) {
			return null;
		}

		$user = get_userdata( $customer_id );
		if ( ! $user ) {
			return null;
		}

		global $wpdb;
		$bookings_table = $wpdb->prefix . 'bc_bookings';

		$stats = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT
					COUNT(*) AS total_bookings,
					SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
					MAX(CASE WHEN status = 'completed' THEN slot_start ELSE NULL END) AS last_visit,
					MIN(CASE WHEN status = 'confirmed' AND slot_start > %s THEN slot_start ELSE NULL END) AS next_booking,
					MIN(created_at) AS first_booking_at
				FROM {$bookings_table}
				WHERE provider_id = %d AND customer_id = %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				current_time( 'mysql' ),
				$provider_id,
				$customer_id
			),
			ARRAY_A
		);

		$bookings = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, slot_start, slot_end, status, created_at FROM {$bookings_table} WHERE provider_id = %d AND customer_id = %d ORDER BY slot_start DESC LIMIT 50", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$provider_id,
				$customer_id
			),
			ARRAY_A
		);

		return [
			'customer' => [
				'id'    => $customer_id,
				'name'  => $user->display_name,
				'email' => $user->user_email,
				'phone' => $this->phones_by_id( [ $customer_id ] )[ $customer_id ] ?? null,
			],
			'overview' => [
				'totalBookings'  => (int) ( $stats['total_bookings'] ?? 0 ),
				'completedCount' => (int) ( $stats['completed_count'] ?? 0 ),
				'lastVisit'      => $stats['last_visit'] ?? null,
				'nextBooking'    => $stats['next_booking'] ?? null,
				'firstBookingAt' => $stats['first_booking_at'] ?? null,
			],
			'bookings'     => array_map(
				static fn( array $b ) => [
					'id'        => (int) $b['id'],
					'slotStart' => $b['slot_start'],
					'slotEnd'   => $b['slot_end'],
					'status'    => $b['status'],
				],
				$bookings
			),
			'reviews'      => $this->reviews_for( $provider_id, $customer_id ),
			'conversation' => $this->conversation_summary( $provider_id, $customer_id ),
			'notes'        => $this->list_notes( $provider_id, $customer_id ),
		];
	}

	private function reviews_for( int $provider_id, int $customer_id ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_reviews';
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, rating, body, response, created_at FROM {$table} WHERE target_type = %s AND target_id = %d AND author_id = %d ORDER BY created_at DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				self::REVIEW_TARGET_TYPE,
				$provider_id,
				$customer_id
			),
			ARRAY_A
		);

		return array_map(
			static fn( array $r ) => [
				'id'        => (int) $r['id'],
				'rating'    => (int) $r['rating'],
				'body'      => $r['body'],
				'response'  => $r['response'],
				'createdAt' => $r['created_at'],
			],
			$rows
		);
	}

	/**
	 * A read-only lookup against the real conversation between this
	 * professional's own WP user account and this customer — deliberately
	 * not ConversationService::start_or_get(), which creates a conversation
	 * on a miss; a CRM detail view must never have that side effect.
	 * Message *content* is never duplicated here — only enough to show "a
	 * conversation exists, N unread, last activity when" and let the
	 * professional open the real chat panel for the rest.
	 */
	private function conversation_summary( int $provider_id, int $customer_id ): ?array {
		$provider_post = get_post( $provider_id );
		if ( ! $provider_post ) {
			return null;
		}
		$professional_user_id = (int) $provider_post->post_author;

		global $wpdb;
		$table = $wpdb->prefix . 'bc_conversations';
		[ $a, $b ] = $professional_user_id < $customer_id ? [ $professional_user_id, $customer_id ] : [ $customer_id, $professional_user_id ];

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT id, last_message_at FROM {$table} WHERE participant_a_id = %d AND participant_b_id = %d AND type = 'pro'", $a, $b ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		if ( ! $row ) {
			return null;
		}

		$unread = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_messages WHERE conversation_id = %d AND sender_id != %d AND read_at IS NULL",
				(int) $row['id'],
				$professional_user_id
			)
		);

		return [
			'conversationId' => (int) $row['id'],
			'lastMessageAt'  => $row['last_message_at'],
			'unreadCount'    => $unread,
		];
	}

	public function list_notes( int $provider_id, int $customer_id ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_crm_notes';
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT n.id, n.note, n.author_user_id, n.created_at, n.updated_at FROM {$table} n WHERE n.provider_id = %d AND n.customer_id = %d ORDER BY n.created_at DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$provider_id,
				$customer_id
			),
			ARRAY_A
		);

		return array_map(
			static function ( array $r ) {
				$author = get_userdata( (int) $r['author_user_id'] );
				return [
					'id'         => (int) $r['id'],
					'note'       => $r['note'],
					'authorName' => $author ? $author->display_name : '',
					'createdAt'  => $r['created_at'],
				];
			},
			$rows
		);
	}

	/**
	 * Ownership is re-checked here, not just at the controller layer — a
	 * note write path must never trust that the caller already validated
	 * $customer_id, since this method is the actual security boundary the
	 * database enforces, not just where the check happens to also live.
	 */
	public function add_note( int $provider_id, int $customer_id, int $author_user_id, string $note ): ?array {
		if ( ! $this->is_customer_of( $provider_id, $customer_id ) ) {
			return null;
		}
		$note = trim( $note );
		if ( $note === '' ) {
			return null;
		}
		$note = mb_substr( $note, 0, 2000 );

		global $wpdb;
		$now = current_time( 'mysql' );
		$wpdb->insert(
			$wpdb->prefix . 'bc_crm_notes',
			[
				'provider_id'    => $provider_id,
				'customer_id'    => $customer_id,
				'author_user_id' => $author_user_id,
				'note'           => $note,
				'created_at'     => $now,
				'updated_at'     => $now,
			],
			[ '%d', '%d', '%d', '%s', '%s', '%s' ]
		);

		$id     = (int) $wpdb->insert_id;
		$author = get_userdata( $author_user_id );

		return [
			'id'         => $id,
			'note'       => $note,
			'authorName' => $author ? $author->display_name : '',
			'createdAt'  => $now,
		];
	}

	/** @return array<int, \WP_User> */
	private function users_by_id( array $ids ): array {
		if ( ! $ids ) {
			return [];
		}
		$users = get_users( [ 'include' => $ids, 'fields' => [ 'ID', 'display_name', 'user_email' ] ] );
		$byId  = [];
		foreach ( $users as $u ) {
			$byId[ (int) $u->ID ] = $u;
		}
		return $byId;
	}

	/** @return array<int, string> customer_id => phone, only for those who have one on file (WooCommerce's own standard billing-phone meta key — the same field the checkout form this site already ships writes to). */
	private function phones_by_id( array $ids ): array {
		if ( ! $ids ) {
			return [];
		}
		global $wpdb;
		$placeholders = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT user_id, meta_value FROM {$wpdb->usermeta} WHERE meta_key = '_billing_phone' AND user_id IN ({$placeholders})", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$ids
			),
			ARRAY_A
		);
		$byId = [];
		foreach ( $rows as $r ) {
			if ( $r['meta_value'] !== '' ) {
				$byId[ (int) $r['user_id'] ] = $r['meta_value'];
			}
		}
		return $byId;
	}

	/** @return array<int, array{count: int}> */
	private function review_summary_by_customer( int $provider_id, array $customer_ids ): array {
		if ( ! $customer_ids ) {
			return [];
		}
		global $wpdb;
		$table        = $wpdb->prefix . 'bc_reviews';
		$placeholders = implode( ',', array_fill( 0, count( $customer_ids ), '%d' ) );
		$params       = array_merge( [ self::REVIEW_TARGET_TYPE, $provider_id ], $customer_ids );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT author_id, COUNT(*) AS cnt FROM {$table} WHERE target_type = %s AND target_id = %d AND author_id IN ({$placeholders}) GROUP BY author_id", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$params
			),
			ARRAY_A
		);
		$byId = [];
		foreach ( $rows as $r ) {
			$byId[ (int) $r['author_id'] ] = [ 'count' => (int) $r['cnt'] ];
		}
		return $byId;
	}

	/** @return array<int, int> customer_id => note count */
	private function notes_count_by_customer( int $provider_id, array $customer_ids ): array {
		if ( ! $customer_ids ) {
			return [];
		}
		global $wpdb;
		$table        = $wpdb->prefix . 'bc_crm_notes';
		$placeholders = implode( ',', array_fill( 0, count( $customer_ids ), '%d' ) );
		$params       = array_merge( [ $provider_id ], $customer_ids );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT customer_id, COUNT(*) AS cnt FROM {$table} WHERE provider_id = %d AND customer_id IN ({$placeholders}) GROUP BY customer_id", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$params
			),
			ARRAY_A
		);
		$byId = [];
		foreach ( $rows as $r ) {
			$byId[ (int) $r['customer_id'] ] = (int) $r['cnt'];
		}
		return $byId;
	}

	/** Normalizes Persian and Arabic-Indic digits to ASCII so search matches a phone number regardless of which numeral system the professional typed it in. */
	private static function normalize_digits( string $s ): string {
		$persian = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];
		$arabic  = [ '٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩' ];
		$ascii   = [ '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' ];
		return str_replace( $arabic, $ascii, str_replace( $persian, $ascii, $s ) );
	}
}
