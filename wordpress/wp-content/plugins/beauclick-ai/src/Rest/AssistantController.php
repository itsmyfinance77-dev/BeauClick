<?php
declare( strict_types=1 );

namespace BeauClick\AI\Rest;

use BeauClick\AI\AssistantService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use WP_REST_Request;

final class AssistantController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/ai/messages',
			[
				[
					'methods'             => 'GET',
					'callback'            => [ $this, 'list_messages' ],
					'permission_callback' => [ $this, 'can_use' ],
				],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'send' ],
					'permission_callback' => [ $this, 'can_use' ],
					'args'                => [ 'body' => [ 'type' => 'string', 'required' => true ] ],
				],
			]
		);

		$this->route(
			'/ai/recommendations/(?P<id>\d+)/click',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'click' ],
				'permission_callback' => [ $this, 'require_login' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	public function can_use(): bool|\WP_Error {
		return $this->require_capability( 'bc_use_ai_assistant' );
	}

	public function list_messages(): \WP_REST_Response {
		$service      = new AssistantService();
		$conversation = $service->get_or_create_conversation( get_current_user_id() );

		return Response::ok( $service->messages( $conversation['id'] ) );
	}

	public function send( WP_REST_Request $request ) {
		$result = ( new AssistantService() )->send( get_current_user_id(), (string) $request->get_param( 'body' ) );

		if ( false === $result ) {
			return Response::error( 'bc_rate_limited', __( 'تعداد پیام‌های شما زیاد بوده — کمی صبر کنید.', 'beauclick-ai' ), 429 );
		}
		if ( is_string( $result ) ) {
			return Response::error( 'bc_invalid_message', $result, 400 );
		}

		return Response::ok( $result, [], 201 );
	}

	public function click( WP_REST_Request $request ) {
		$ok = ( new AssistantService() )->mark_clicked( (int) $request->get_param( 'id' ), get_current_user_id() );

		return $ok
			? Response::ok( [ 'clicked' => true ] )
			: Response::error( 'bc_not_found', __( 'پیشنهاد پیدا نشد.', 'beauclick-ai' ), 404 );
	}
}
