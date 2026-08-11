<?php
declare( strict_types=1 );

namespace BeauClick\Chat\Chat;

/**
 * Custom tables + plain REST + client polling for v1 (architecture doc
 * §15) — deliberately not WebSockets: PHP-FPM hosting doesn't hold
 * long-lived connections cheaply, and a single-city launch doesn't need
 * sub-second delivery. send_message() fires 'beauclick/chat/message_sent'
 * on every insert — the seam a future realtime relay would subscribe to,
 * so upgrading later is additive, not a rewrite.
 */
final class ConversationService {

	/** Max messages a single user may send within the rate-limit window (architecture doc §20: chat send is a real abuse vector). */
	private const RATE_LIMIT_MAX    = 20;
	private const RATE_LIMIT_WINDOW = MINUTE_IN_SECONDS;

	/**
	 * Finds or creates the (customer, counterpart) conversation, keyed by
	 * participants in canonical order so it's found the same way regardless
	 * of who messages first.
	 */
	public function start_or_get( int $user_a, int $user_b, string $type = 'pro' ): ?array {
		if ( $user_a === $user_b || $user_a <= 0 || $user_b <= 0 ) {
			return null;
		}

		global $wpdb;
		$table = $wpdb->prefix . 'bc_conversations';
		[ $a, $b ] = $user_a < $user_b ? [ $user_a, $user_b ] : [ $user_b, $user_a ];

		$existing = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE participant_a_id = %d AND participant_b_id = %d AND type = %s", $a, $b, $type ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		if ( $existing ) {
			return $this->format( $existing );
		}

		$wpdb->insert(
			$table,
			[
				'type'             => $type,
				'participant_a_id' => $a,
				'participant_b_id' => $b,
				'created_at'       => current_time( 'mysql' ),
			],
			[ '%s', '%d', '%d', '%s' ]
		);

		// A concurrent request may have inserted the same pair between the
		// SELECT above and this INSERT — the UNIQUE key rejects our insert
		// rather than creating a duplicate; re-read whichever row won.
		if ( ! $wpdb->insert_id ) {
			$row = $wpdb->get_row(
				$wpdb->prepare( "SELECT * FROM {$table} WHERE participant_a_id = %d AND participant_b_id = %d AND type = %s", $a, $b, $type ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				ARRAY_A
			);
			return $row ? $this->format( $row ) : null;
		}

		return $this->find( $wpdb->insert_id );
	}

	public function find( int $conversation_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_conversations WHERE id = %d", $conversation_id ),
			ARRAY_A
		);
		return $row ? $this->format( $row ) : null;
	}

	public function is_participant( array $conversation, int $user_id ): bool {
		return $user_id === $conversation['participantAId'] || $user_id === $conversation['participantBId'];
	}

	public function other_participant( array $conversation, int $user_id ): int {
		return $user_id === $conversation['participantAId'] ? $conversation['participantBId'] : $conversation['participantAId'];
	}

	/** @return array<int, array<string, mixed>> */
	public function list_for_user( int $user_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_conversations WHERE participant_a_id = %d OR participant_b_id = %d ORDER BY last_message_at IS NULL, last_message_at DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$user_id,
				$user_id
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/** @return array<int, array<string, mixed>> */
	public function messages( int $conversation_id, int $limit = 50 ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM ( SELECT * FROM {$wpdb->prefix}bc_messages WHERE conversation_id = %d ORDER BY id DESC LIMIT %d ) recent ORDER BY id ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$conversation_id,
				$limit
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format_message' ], $rows ?: [] );
	}

	public function unread_count( int $conversation_id, int $user_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_messages WHERE conversation_id = %d AND sender_id != %d AND read_at IS NULL", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$conversation_id,
				$user_id
			)
		);
	}

	/**
	 * Returns the created message, `null` for a blank body, or `false` if
	 * the sender has hit the rate limit — three distinct outcomes the REST
	 * controller maps to 400/429/201 respectively.
	 */
	public function send_message( int $conversation_id, int $sender_id, string $body ): array|false|null {
		$body = trim( $body );
		if ( '' === $body ) {
			return null;
		}

		$rate_key = "bc_chat_rate_{$sender_id}";
		$count    = (int) get_transient( $rate_key );
		if ( $count >= self::RATE_LIMIT_MAX ) {
			return false;
		}
		set_transient( $rate_key, $count + 1, self::RATE_LIMIT_WINDOW );

		global $wpdb;
		$now = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_messages',
			[
				'conversation_id' => $conversation_id,
				'sender_id'       => $sender_id,
				'body'            => $body,
				'created_at'      => $now,
			],
			[ '%d', '%d', '%s', '%s' ]
		);
		$message_id = $wpdb->insert_id;

		$wpdb->update(
			$wpdb->prefix . 'bc_conversations',
			[ 'last_message_at' => $now ],
			[ 'id' => $conversation_id ],
			[ '%s' ],
			[ '%d' ]
		);

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'message_sent', 'conversation', $conversation_id, $sender_id );
		}

		$message = $this->find_message( $message_id );

		/**
		 * The seam a future realtime relay (small Node/WebSocket bridge, or a
		 * hosted service like Pusher/Mercure) would subscribe to — see
		 * architecture doc §15. No listener today; firing it costs nothing.
		 */
		do_action( 'beauclick/chat/message_sent', $message, $conversation_id );

		return $message;
	}

	public function mark_read( int $conversation_id, int $user_id ): void {
		global $wpdb;
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_messages SET read_at = %s WHERE conversation_id = %d AND sender_id != %d AND read_at IS NULL", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				current_time( 'mysql' ),
				$conversation_id,
				$user_id
			)
		);
	}

	private function find_message( int $message_id ): array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_messages WHERE id = %d", $message_id ), ARRAY_A );
		return $this->format_message( $row );
	}

	private function format( array $row ): array {
		return [
			'id'              => (int) $row['id'],
			'type'            => $row['type'],
			'participantAId'  => (int) $row['participant_a_id'],
			'participantBId'  => (int) $row['participant_b_id'],
			'lastMessageAt'   => $row['last_message_at'],
			'createdAt'       => $row['created_at'],
		];
	}

	private function format_message( array $row ): array {
		return [
			'id'             => (int) $row['id'],
			'conversationId' => (int) $row['conversation_id'],
			'senderId'       => $row['sender_id'] ? (int) $row['sender_id'] : null,
			'body'           => $row['body'],
			'createdAt'      => $row['created_at'],
			'readAt'         => $row['read_at'],
		];
	}
}
