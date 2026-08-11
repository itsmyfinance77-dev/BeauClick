<?php
declare( strict_types=1 );

namespace BeauClick\Chat\Rest;

use BeauClick\Chat\Chat\ConversationService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use WP_REST_Request;

final class ChatController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/chat/conversations',
			[
				[
					'methods'             => 'GET',
					'callback'            => [ $this, 'list_conversations' ],
					'permission_callback' => [ $this, 'require_login' ],
				],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'start_conversation' ],
					'permission_callback' => [ $this, 'can_send' ],
					'args'                => [
						'counterpart_id' => [ 'type' => 'integer', 'required' => true ],
						'type'           => [ 'type' => 'string', 'required' => false ],
					],
				],
			]
		);

		$this->route(
			'/chat/conversations/(?P<id>\d+)/messages',
			[
				[
					'methods'             => 'GET',
					'callback'            => [ $this, 'list_messages' ],
					'permission_callback' => [ $this, 'can_access_conversation' ],
					'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
				],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'send_message' ],
					'permission_callback' => [ $this, 'can_access_conversation' ],
					'args'                => [
						'id'   => [ 'type' => 'integer', 'required' => true ],
						'body' => [ 'type' => 'string', 'required' => true ],
					],
				],
			]
		);

		$this->route(
			'/chat/conversations/(?P<id>\d+)/read',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'mark_read' ],
				'permission_callback' => [ $this, 'can_access_conversation' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	public function can_send(): bool|\WP_Error {
		return $this->require_capability( 'bc_send_message' );
	}

	/**
	 * A conversation has no post_author to key off of (it isn't a CPT) —
	 * this is the same ownership shape as require_owner_or_capability but
	 * checked against either of the two participant columns instead of one,
	 * so support/admin (bc_view_all_conversations) can still read for
	 * moderation without being a participant themselves.
	 */
	public function can_access_conversation( WP_REST_Request $request ): bool|\WP_Error {
		$conversation = ( new ConversationService() )->find( (int) $request->get_param( 'id' ) );
		if ( ! $conversation ) {
			return true; // Let the handler 404 — permission isn't the interesting failure here.
		}
		$user_id = get_current_user_id();
		if ( $user_id && ( new ConversationService() )->is_participant( $conversation, $user_id ) ) {
			return true;
		}
		return $this->require_capability( 'bc_view_all_conversations' );
	}

	public function list_conversations(): \WP_REST_Response {
		$user_id  = get_current_user_id();
		$service  = new ConversationService();
		$rows     = $service->list_for_user( $user_id );

		return Response::ok(
			array_map(
				function ( array $c ) use ( $service, $user_id ) {
					$other_id = $service->other_participant( $c, $user_id );
					$other    = get_userdata( $other_id );
					global $wpdb;
					$last_message = $wpdb->get_row(
						$wpdb->prepare( "SELECT body FROM {$wpdb->prefix}bc_messages WHERE conversation_id = %d ORDER BY id DESC LIMIT 1", $c['id'] ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
						ARRAY_A
					);

					return [
						'id'              => $c['id'],
						'type'            => $c['type'],
						'otherUserId'     => $other_id,
						'otherUserName'   => $other ? $other->display_name : '',
						'lastMessageAt'   => $c['lastMessageAt'],
						'lastMessage'     => $last_message ? mb_substr( $last_message['body'], 0, 80 ) : '',
						'unreadCount'     => $service->unread_count( $c['id'], $user_id ),
					];
				},
				$rows
			)
		);
	}

	public function start_conversation( WP_REST_Request $request ) {
		$user_id = get_current_user_id();
		$counterpart_id = (int) $request->get_param( 'counterpart_id' );
		$type = (string) ( $request->get_param( 'type' ) ?: 'pro' );

		$conversation = ( new ConversationService() )->start_or_get( $user_id, $counterpart_id, $type );
		if ( ! $conversation ) {
			return Response::error( 'bc_invalid_counterpart', __( 'نمی‌توان با این کاربر گفتگو شروع کرد.', 'beauclick-chat' ), 400 );
		}

		return Response::ok( [ 'id' => $conversation['id'] ], [], 201 );
	}

	public function list_messages( WP_REST_Request $request ) {
		$service = new ConversationService();
		$conversation = $service->find( (int) $request->get_param( 'id' ) );
		if ( ! $conversation ) {
			return Response::error( 'bc_not_found', __( 'گفتگو پیدا نشد.', 'beauclick-chat' ), 404 );
		}

		return Response::ok( $service->messages( $conversation['id'] ) );
	}

	public function send_message( WP_REST_Request $request ) {
		$service = new ConversationService();
		$conversation = $service->find( (int) $request->get_param( 'id' ) );
		if ( ! $conversation ) {
			return Response::error( 'bc_not_found', __( 'گفتگو پیدا نشد.', 'beauclick-chat' ), 404 );
		}

		$result = $service->send_message( $conversation['id'], get_current_user_id(), (string) $request->get_param( 'body' ) );

		if ( false === $result ) {
			return Response::error( 'bc_rate_limited', __( 'تعداد پیام‌های شما در این دقیقه زیاد بوده — کمی صبر کنید.', 'beauclick-chat' ), 429 );
		}
		if ( null === $result ) {
			return Response::error( 'bc_empty_message', __( 'متن پیام نمی‌تواند خالی باشد.', 'beauclick-chat' ), 400 );
		}

		return Response::ok( $result, [], 201 );
	}

	public function mark_read( WP_REST_Request $request ) {
		$service = new ConversationService();
		$conversation = $service->find( (int) $request->get_param( 'id' ) );
		if ( ! $conversation ) {
			return Response::error( 'bc_not_found', __( 'گفتگو پیدا نشد.', 'beauclick-chat' ), 404 );
		}

		$service->mark_read( $conversation['id'], get_current_user_id() );
		return Response::ok( [ 'marked' => true ] );
	}
}
