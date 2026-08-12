<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * Orchestrates one AI turn: guard -> persist user message -> call the
 * configured provider -> validate its recommendations against real DB rows
 * -> persist the reply -> log recommendation-shown events. This is the one
 * place that does DB-existence validation, so it applies uniformly
 * regardless of which ProviderInterface implementation produced the
 * recommendation (architecture doc §16 — never trust the model's IDs
 * blindly, whether the model is a real LLM or the rule-based fallback).
 */
final class AssistantService {

	private const RATE_LIMIT_MAX    = 15;
	private const RATE_LIMIT_WINDOW = MINUTE_IN_SECONDS;

	public function __construct(
		private readonly ProviderFactory $providerFactory = new ProviderFactory(),
		private readonly MessageGuard $guard = new MessageGuard()
	) {
	}

	public function get_or_create_conversation( int $user_id ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_ai_conversations';

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE user_id = %d", $user_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( $row ) {
			return $this->format_conversation( $row );
		}

		$wpdb->insert( $table, [ 'user_id' => $user_id, 'created_at' => current_time( 'mysql' ) ], [ '%d', '%s' ] );
		return $this->format_conversation(
			$wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", $wpdb->insert_id ), ARRAY_A ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
	}

	/** @return array<int, array<string, mixed>> */
	public function messages( int $conversation_id, int $limit = 50 ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM ( SELECT * FROM {$wpdb->prefix}bc_ai_messages WHERE conversation_id = %d ORDER BY id DESC LIMIT %d ) recent ORDER BY id ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$conversation_id,
				$limit
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format_message' ], $rows ?: [] );
	}

	/**
	 * Returns ['userMessage' => ..., 'assistantMessage' => ...] on success,
	 * or `false` if the sender hit the rate limit, or a string error message
	 * if the guard rejected the input — three outcomes the REST controller
	 * maps to 201/429/400 respectively.
	 */
	public function send( int $user_id, string $text ): array|false|string {
		if ( $error = $this->guard->check( $text ) ) {
			return $error;
		}

		$rate_key = "bc_ai_rate_{$user_id}";
		$count    = (int) get_transient( $rate_key );
		if ( $count >= self::RATE_LIMIT_MAX ) {
			return false;
		}
		set_transient( $rate_key, $count + 1, self::RATE_LIMIT_WINDOW );

		global $wpdb;
		$conversation = $this->get_or_create_conversation( $user_id );
		$now          = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_ai_messages',
			[ 'conversation_id' => $conversation['id'], 'sender_id' => $user_id, 'body' => trim( $text ), 'created_at' => $now ],
			[ '%d', '%d', '%s', '%s' ]
		);
		$user_message = $this->find_message( $wpdb->insert_id );

		$history = array_map(
			static fn ( array $m ) => [ 'role' => $m['senderId'] ? 'user' : 'assistant', 'content' => $m['body'] ],
			$this->messages( $conversation['id'], 20 )
		);

		// V2.0 Step 4: Beauty Journey provides context, AI remains solely
		// responsible for recommendation reasoning (task's own explicit
		// domain boundary) -- a customer's stored preferences/active goal
		// only ever fill gaps the CURRENT conversation hasn't already stated
		// (merge order: journey defaults first, conversation's own
		// accumulated context second, so an explicit signal always wins).
		// Optional dependency: AI must keep working with zero journey data,
		// exactly as it did before this plugin existed.
		$context = $conversation['aiContext'];
		if ( class_exists( \BeauClick\Journey\Context\JourneyContextProvider::class ) ) {
			$context = array_merge( ( new \BeauClick\Journey\Context\JourneyContextProvider() )->infer_ai_defaults( $user_id ), $context );
		}

		$response = $this->providerFactory->make()->chat( $history, $context );

		$valid_recommendations = $this->validate_recommendations( $response->recommendations );
		$merged_context        = array_merge( $conversation['aiContext'], $response->contextUpdates );

		$wpdb->insert(
			$wpdb->prefix . 'bc_ai_messages',
			[
				'conversation_id' => $conversation['id'],
				'sender_id'       => null,
				'body'            => $response->reply,
				'recommendations' => $valid_recommendations ? wp_json_encode( $valid_recommendations ) : null,
				'created_at'      => current_time( 'mysql' ),
			],
			[ '%d', '%d', '%s', '%s', '%s' ]
		);
		$assistant_message_id = $wpdb->insert_id;

		$wpdb->update(
			$wpdb->prefix . 'bc_ai_conversations',
			[ 'ai_context' => wp_json_encode( $merged_context ), 'last_message_at' => current_time( 'mysql' ) ],
			[ 'id' => $conversation['id'] ],
			[ '%s', '%s' ],
			[ '%d' ]
		);

		foreach ( $valid_recommendations as $rec ) {
			$wpdb->insert(
				$wpdb->prefix . 'bc_ai_recommendation_events',
				[
					'conversation_id'  => $conversation['id'],
					'message_id'       => $assistant_message_id,
					'recommended_type' => $rec['type'],
					'recommended_id'   => $rec['id'],
					'created_at'       => current_time( 'mysql' ),
				],
				[ '%d', '%d', '%s', '%d', '%s' ]
			);
			if ( function_exists( 'beauclick_core' ) ) {
				beauclick_core()->events()->log( 'ai_recommendation_shown', $rec['type'], $rec['id'], $user_id );
			}
		}

		return [
			'userMessage'      => $user_message,
			'assistantMessage' => $this->find_message( $assistant_message_id ),
		];
	}

	/**
	 * Marks a recommendation as clicked — the "clicked" column architecture
	 * doc §8 calls out as the seed data for measuring whether AI
	 * recommendations actually drive bookings/purchases later. Ownership is
	 * checked against the AI conversation's own user_id, same shape as every
	 * other "act on my own thing" endpoint in the codebase.
	 */
	public function mark_clicked( int $event_id, int $user_id ): bool {
		global $wpdb;
		$event = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT e.*, c.user_id FROM {$wpdb->prefix}bc_ai_recommendation_events e JOIN {$wpdb->prefix}bc_ai_conversations c ON c.id = e.conversation_id WHERE e.id = %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_id
			),
			ARRAY_A
		);
		if ( ! $event || (int) $event['user_id'] !== $user_id ) {
			return false;
		}

		$wpdb->update( $wpdb->prefix . 'bc_ai_recommendation_events', [ 'clicked' => 1 ], [ 'id' => $event_id ], [ '%d' ], [ '%d' ] );
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'ai_recommendation_clicked', $event['recommended_type'], (int) $event['recommended_id'], $user_id );
		}
		return true;
	}

	public function conversation_belongs_to( int $conversation_id, int $user_id ): bool {
		global $wpdb;
		$owner = $wpdb->get_var( $wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_ai_conversations WHERE id = %d", $conversation_id ) );
		return null !== $owner && (int) $owner === $user_id;
	}

	/**
	 * The one place that does DB-existence validation on every recommendation
	 * type, regardless of which ProviderInterface implementation produced
	 * it — architecture doc §16, "never trust the model's IDs blindly."
	 * V2.0 Step 2 added the 'service' case; every case here is a hard
	 * existence + eligibility check against the real domain table, never a
	 * trust of whatever the provider claimed.
	 *
	 * @param array<int, array{type: string, id: int, reason?: string}> $recommendations
	 */
	private function validate_recommendations( array $recommendations ): array {
		global $wpdb;
		$valid = [];

		foreach ( $recommendations as $rec ) {
			if ( 'provider' === $rec['type'] ) {
				$exists = (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $rec['id'] ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				if ( $exists ) {
					$valid[] = $rec;
				}
			} elseif ( 'product' === $rec['type'] && function_exists( 'wc_get_product' ) ) {
				$product = wc_get_product( $rec['id'] );
				// is_visible() is false for catalog_visibility='hidden' —
				// exactly what ServiceProductSync sets on every bookable
				// service's linked product, so a booking-only product can
				// never surface here as an ordinary Shop-style recommendation.
				if ( $product && $product->is_visible() ) {
					$valid[] = $rec;
				}
			} elseif ( 'service' === $rec['type'] ) {
				$service = get_post( $rec['id'] );
				if ( $service && \BeauClick\Marketplace\PostTypes\Registrar::SERVICE === $service->post_type && 'publish' === $service->post_status ) {
					$parent = get_post( $service->post_parent );
					if ( $parent && 'publish' === $parent->post_status ) {
						$valid[] = $rec;
					}
				}
			}
		}

		return $valid;
	}

	private function find_message( int $message_id ): array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_ai_messages WHERE id = %d", $message_id ), ARRAY_A );
		return $this->format_message( $row );
	}

	private function format_conversation( array $row ): array {
		return [
			'id'        => (int) $row['id'],
			'userId'    => (int) $row['user_id'],
			'aiContext' => $row['ai_context'] ? (array) json_decode( (string) $row['ai_context'], true ) : [],
		];
	}

	private function format_message( array $row ): array {
		$recommendations = $row['recommendations'] ? json_decode( (string) $row['recommendations'], true ) : [];

		return [
			'id'              => (int) $row['id'],
			'conversationId'  => (int) $row['conversation_id'],
			'senderId'        => $row['sender_id'] ? (int) $row['sender_id'] : null,
			'body'            => $row['body'],
			'recommendations' => $this->enrich_recommendations( (int) $row['id'], (array) $recommendations ),
			'createdAt'       => $row['created_at'],
		];
	}

	/**
	 * The stored {type, id} pairs are the source of truth (re-validated
	 * against real rows at write time — see validate_recommendations());
	 * this only adds display data on read so the frontend can render a card
	 * without a second round trip per recommendation. A row that vanished
	 * between write and read (e.g. the provider was since unpublished) is
	 * silently dropped here rather than shown broken.
	 */
	private function enrich_recommendations( int $message_id, array $recommendations ): array {
		global $wpdb;
		$enriched = [];

		$events = $wpdb->get_results(
			$wpdb->prepare( "SELECT id, recommended_type, recommended_id FROM {$wpdb->prefix}bc_ai_recommendation_events WHERE message_id = %d", $message_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		$event_id_for = static function ( string $type, int $id ) use ( $events ): ?int {
			foreach ( $events as $e ) {
				if ( $e['recommended_type'] === $type && (int) $e['recommended_id'] === $id ) {
					return (int) $e['id'];
				}
			}
			return null;
		};

		foreach ( $recommendations as $rec ) {
			$reason = isset( $rec['reason'] ) && is_string( $rec['reason'] ) ? $rec['reason'] : null;

			if ( 'provider' === $rec['type'] ) {
				$row = $wpdb->get_row(
					$wpdb->prepare( "SELECT name, price_from, rating_avg, review_count FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $rec['id'] ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					ARRAY_A
				);
				if ( ! $row ) {
					continue;
				}
				$enriched[] = [
					'type'        => 'provider',
					'id'          => $rec['id'],
					'eventId'     => $event_id_for( 'provider', $rec['id'] ),
					'name'        => $row['name'],
					'url'         => get_permalink( $rec['id'] ) ?: null,
					'priceFrom'   => null !== $row['price_from'] ? (int) $row['price_from'] : null,
					'rating'      => (float) $row['rating_avg'],
					'reviewCount' => (int) $row['review_count'],
					'reason'      => $reason,
				];
			} elseif ( 'product' === $rec['type'] && function_exists( 'wc_get_product' ) ) {
				$product = wc_get_product( $rec['id'] );
				if ( ! $product ) {
					continue;
				}
				$enriched[] = [
					'type'    => 'product',
					'id'      => $rec['id'],
					'eventId' => $event_id_for( 'product', $rec['id'] ),
					'name'    => $product->get_name(),
					'url'     => get_permalink( $rec['id'] ) ?: null,
					'price'   => (int) $product->get_price(),
					'image'   => get_the_post_thumbnail_url( $rec['id'], 'medium' ) ?: null,
					'reason'  => $reason,
				];
			} elseif ( 'service' === $rec['type'] ) {
				$service = get_post( $rec['id'] );
				if ( ! $service ) {
					continue;
				}
				$provider_id = (int) $service->post_parent;
				$enriched[]  = [
					'type'            => 'service',
					'id'              => $rec['id'],
					'eventId'         => $event_id_for( 'service', $rec['id'] ),
					'name'            => $service->post_title,
					// A service has no standalone page (bc_service is not
					// publicly queryable) — it deep-links to its provider's
					// real profile page, with query params the existing
					// booking mount reads to pre-open the booking modal on
					// this exact service, reusing the current architecture
					// rather than building a new one.
					'url'             => $provider_id ? add_query_arg( [ 'book_provider' => $provider_id, 'book_service' => $rec['id'] ], get_permalink( $provider_id ) ?: '' ) : null,
					'price'           => (int) get_post_meta( $rec['id'], '_bc_price', true ),
					'durationMinutes' => (int) get_post_meta( $rec['id'], '_bc_duration_minutes', true ),
					'providerId'      => $provider_id ?: null,
					'providerName'    => $provider_id ? get_the_title( $provider_id ) : null,
					'reason'          => $reason,
				];
			}
		}

		return $enriched;
	}
}
