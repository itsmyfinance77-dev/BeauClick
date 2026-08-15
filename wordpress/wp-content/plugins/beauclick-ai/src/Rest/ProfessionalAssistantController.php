<?php
declare( strict_types=1 );

namespace BeauClick\AI\Rest;

use BeauClick\AI\Professional\ProfessionalAssistantService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * The professional-facing counterpart to AssistantController — a wholly
 * separate route, not a `context` parameter grafted onto the existing
 * `/ai/messages` endpoint (V2.3 roadmap's own explicit decision for this
 * step, matching the separate-table decision below it: two clearly
 * distinct identities should never share one ambiguous endpoint either).
 *
 * SECURITY (task §7/§8, the single most important requirement of this
 * step): identity is resolved EXCLUSIVELY from the authenticated session,
 * via ProviderLookup::for_user() -- the same, single, canonical resolution
 * every other ownership-sensitive controller in this codebase uses. No
 * route here accepts a provider_id/professional_id/business_id from the
 * client in any form (query param, body, or URL segment) -- there is
 * nothing for a malicious request to manipulate.
 *
 * Owner-only, no StaffService fallback -- mirrors MyFinanceController's own
 * explicit reasoning (financial/business-data-adjacent AI is at least as
 * sensitive as financial data itself), and matches this step's own task
 * spec (§10: "the safe default is AI access belongs to the authenticated
 * Professional owner" -- staff excluded unless explicitly opted in, which
 * this step's own roadmap definition never does).
 */
final class ProfessionalAssistantController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/ai/professional/messages',
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
	}

	public function can_use(): bool|\WP_Error {
		return $this->require_capability( 'bc_use_professional_ai' );
	}

	/**
	 * Resolves the owned bc_professional/bc_business CPT post id for the
	 * CURRENT session only -- the sole identity source for this whole
	 * controller. Returns null (never an id from any other source) if the
	 * user owns no such post, including for a staff member (ProviderLookup
	 * resolves by post_author only -- see its own docblock).
	 */
	private function resolve_provider( int $user_id ): ?array {
		$provider_id = ProviderLookup::for_user( $user_id );
		if ( ! $provider_id ) {
			return null;
		}
		$post_type = get_post_type( $provider_id );
		if ( ! in_array( $post_type, [ 'bc_professional', 'bc_business' ], true ) ) {
			return null;
		}
		return [ 'id' => $provider_id, 'postType' => $post_type ];
	}

	public function list_messages(): \WP_REST_Response {
		$user_id  = get_current_user_id();
		$provider = $this->resolve_provider( $user_id );
		if ( ! $provider ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-ai' ), 404 );
		}

		$service      = new ProfessionalAssistantService();
		$conversation = $service->get_or_create_conversation( $provider['id'], $user_id );

		return Response::ok( $service->messages( $conversation['id'] ) );
	}

	public function send( WP_REST_Request $request ) {
		$user_id  = get_current_user_id();
		$provider = $this->resolve_provider( $user_id );
		if ( ! $provider ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-ai' ), 404 );
		}

		$result = ( new ProfessionalAssistantService() )->send( $provider['id'], $provider['postType'], $user_id, (string) $request->get_param( 'body' ) );

		if ( false === $result ) {
			return Response::error( 'bc_rate_limited', __( 'تعداد پیام‌های شما زیاد بوده — کمی صبر کنید.', 'beauclick-ai' ), 429 );
		}
		if ( is_string( $result ) ) {
			return Response::error( 'bc_invalid_message', $result, 400 );
		}

		return Response::ok( $result, [], 201 );
	}
}
