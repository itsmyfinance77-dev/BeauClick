<?php
declare( strict_types=1 );

namespace BeauClick\AI\Professional;

use BeauClick\AI\MessageGuard;

/**
 * The professional-mode counterpart to `BeauClick\AI\AssistantService`.
 * Deliberately simpler: no recommendation validation (this mode never
 * recommends catalog entities, only narrates the caller's own real
 * business data), no accumulated/merged context (ProfessionalContext is
 * rebuilt fresh on every turn — see its own docblock for why).
 *
 * SECURITY: every public method here requires an already-resolved
 * $provider_id, supplied by the caller (ProfessionalAssistantController,
 * which resolves it via ProviderLookup::for_user() against the current
 * session — never a client-supplied id). This class does not, and must
 * never, accept a provider_id from request input.
 */
final class ProfessionalAssistantService {

	private const RATE_LIMIT_MAX    = 15;
	private const RATE_LIMIT_WINDOW = MINUTE_IN_SECONDS;

	public function __construct(
		private readonly ProfessionalProviderFactory $providerFactory = new ProfessionalProviderFactory(),
		private readonly MessageGuard $guard = new MessageGuard(),
		private readonly ProfessionalContext $contextBuilder = new ProfessionalContext()
	) {
	}

	/** @return array<string, mixed> */
	public function get_or_create_conversation( int $provider_id, int $user_id ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_ai_professional_conversations';

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE provider_id = %d", $provider_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( $row ) {
			return $this->format_conversation( $row );
		}

		$wpdb->insert( $table, [ 'provider_id' => $provider_id, 'user_id' => $user_id, 'created_at' => current_time( 'mysql' ) ], [ '%d', '%d', '%s' ] );
		return $this->format_conversation(
			$wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $wpdb->insert_id ), ARRAY_A ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
	}

	/**
	 * V2.3 final release audit finding: this table pair was never wired into
	 * beauclick-privacy's export/deletion sweep the way the customer-mode
	 * `AssistantService`'s equivalent methods already are — a professional's
	 * business-AI chat history was an orphaned data domain, neither exported
	 * nor erased on account deletion. Read-only lookup, unlike
	 * get_or_create_conversation(): an export/deletion pass must never CREATE
	 * a conversation for a professional who never used the professional AI.
	 */
	public function find_conversation_for_user( int $user_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_ai_professional_conversations WHERE user_id = %d", $user_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return $row ? $this->format_conversation( $row ) : null;
	}

	/**
	 * Every message in the professional's own AI conversation, for their own
	 * data export — same shape as AssistantService::export_for_user().
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function export_for_user( int $user_id ): array {
		$conversation = $this->find_conversation_for_user( $user_id );
		if ( ! $conversation ) {
			return [];
		}
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT sender_id, body, created_at FROM {$wpdb->prefix}bc_ai_professional_messages WHERE conversation_id = %d ORDER BY id ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$conversation['id']
			),
			ARRAY_A
		);
		return array_map(
			static fn ( array $r ) => [ 'from' => $r['sender_id'] ? 'professional' : 'assistant', 'body' => $r['body'], 'createdAt' => $r['created_at'] ],
			$rows ?: []
		);
	}

	/**
	 * Fully professional-owned, no other party involved. Deleted outright:
	 * conversation and messages. Idempotent — no conversation means nothing
	 * to delete. Matches AssistantService::forget_user()'s exact discipline.
	 */
	public function forget_user( int $user_id ): void {
		$conversation = $this->find_conversation_for_user( $user_id );
		if ( ! $conversation ) {
			return;
		}
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'bc_ai_professional_messages', [ 'conversation_id' => $conversation['id'] ], [ '%d' ] );
		$wpdb->delete( $wpdb->prefix . 'bc_ai_professional_conversations', [ 'id' => $conversation['id'] ], [ '%d' ] );
	}

	/** @return array<int, array<string, mixed>> */
	public function messages( int $conversation_id, int $limit = 50 ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM ( SELECT * FROM {$wpdb->prefix}bc_ai_professional_messages WHERE conversation_id = %d ORDER BY id DESC LIMIT %d ) recent ORDER BY id ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$conversation_id,
				$limit
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format_message' ], $rows ?: [] );
	}

	/**
	 * Returns ['userMessage' => ..., 'assistantMessage' => ...] on success,
	 * `false` if rate-limited, or a Persian error string if the guard
	 * rejected the input — same three-outcome shape as
	 * AssistantService::send(), mapped by the controller to 201/429/400.
	 */
	public function send( int $provider_id, string $provider_post_type, int $user_id, string $text ): array|false|string {
		if ( $error = $this->guard->check( $text ) ) {
			return $error;
		}

		$rate_key = "bc_ai_professional_rate_{$user_id}";
		$count    = (int) get_transient( $rate_key );
		if ( $count >= self::RATE_LIMIT_MAX ) {
			return false;
		}
		set_transient( $rate_key, $count + 1, self::RATE_LIMIT_WINDOW );

		global $wpdb;
		$conversation = $this->get_or_create_conversation( $provider_id, $user_id );
		$now          = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_ai_professional_messages',
			[ 'conversation_id' => $conversation['id'], 'sender_id' => $user_id, 'body' => trim( $text ), 'created_at' => $now ],
			[ '%d', '%d', '%s', '%s' ]
		);
		$user_message = $this->find_message( $wpdb->insert_id );

		$history = array_map(
			static fn ( array $m ) => [ 'role' => $m['senderId'] ? 'user' : 'assistant', 'content' => $m['body'] ],
			$this->messages( $conversation['id'], 20 )
		);

		// Fresh, real, ownership-scoped data on every turn -- never the
		// model's own memory of an earlier turn's numbers (see
		// ProfessionalContext's own docblock).
		$context = $this->contextBuilder->for_provider( $provider_id, $provider_post_type );

		$response = $this->providerFactory->make()->chat( $history, $context );

		$wpdb->insert(
			$wpdb->prefix . 'bc_ai_professional_messages',
			[ 'conversation_id' => $conversation['id'], 'sender_id' => null, 'body' => $response->reply, 'created_at' => current_time( 'mysql' ) ],
			[ '%d', '%d', '%s', '%s' ]
		);
		$assistant_message_id = $wpdb->insert_id;

		$wpdb->update(
			$wpdb->prefix . 'bc_ai_professional_conversations',
			[ 'last_message_at' => current_time( 'mysql' ) ],
			[ 'id' => $conversation['id'] ],
			[ '%s' ],
			[ '%d' ]
		);

		return [
			'userMessage'      => $user_message,
			'assistantMessage' => $this->find_message( $assistant_message_id ),
		];
	}

	/**
	 * The real cross-professional-isolation boundary for reading an
	 * arbitrary conversation id: a conversation belongs to a provider, and
	 * this must be checked against the CALLER's own resolved provider_id,
	 * never trusted from client input.
	 */
	public function conversation_belongs_to( int $conversation_id, int $provider_id ): bool {
		global $wpdb;
		$owner = $wpdb->get_var( $wpdb->prepare( "SELECT provider_id FROM {$wpdb->prefix}bc_ai_professional_conversations WHERE id = %d", $conversation_id ) );
		return null !== $owner && (int) $owner === $provider_id;
	}

	private function find_message( int $message_id ): array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_ai_professional_messages WHERE id = %d", $message_id ), ARRAY_A );
		return $this->format_message( $row );
	}

	private function format_conversation( array $row ): array {
		return [
			'id'         => (int) $row['id'],
			'providerId' => (int) $row['provider_id'],
			'userId'     => (int) $row['user_id'],
		];
	}

	private function format_message( array $row ): array {
		return [
			'id'             => (int) $row['id'],
			'conversationId' => (int) $row['conversation_id'],
			'senderId'       => $row['sender_id'] ? (int) $row['sender_id'] : null,
			'body'           => $row['body'],
			'createdAt'      => $row['created_at'],
		];
	}
}
