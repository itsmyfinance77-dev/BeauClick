<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Financial\SettlementService;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * The professional/business-facing counterpart to the admin Financial page
 * -- mirrors `MyAnalyticsController`'s own ownership-resolution shape
 * (V2.2 Step 16), with one deliberate difference: this controller resolves
 * ownership via `ProviderLookup::for_user()` ONLY, never the `StaffService`
 * fallback `MyAnalyticsController` also accepts. Financial data is more
 * sensitive than analytics counts -- V2.3's own architecture plan already
 * named "staff visibility into financial data defaults to owner-only,
 * pending an explicit business decision otherwise" as a standing
 * constraint from Step 17's own planning pass, honoured here rather than
 * silently expanded.
 *
 * Never accepts a client-supplied provider/business id (task §28) -- the
 * only identity this controller ever resolves is the current session's own.
 */
final class MyFinanceController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/financial/my-summary',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'summary' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);
	}

	public function summary( WP_REST_Request $request ): \WP_REST_Response {
		$user_id     = get_current_user_id();
		$provider_id = ProviderLookup::for_user( $user_id );

		if ( ! $provider_id ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-financial' ), 404 );
		}

		$post_type = get_post_type( $provider_id );
		$party_type = 'bc_business' === $post_type ? 'business' : ( 'bc_professional' === $post_type ? 'professional' : null );
		if ( ! $party_type ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-financial' ), 404 );
		}

		$settlements = new SettlementService();

		return Response::ok(
			[
				'partyType'   => $party_type,
				'partyId'     => $provider_id,
				'summary'     => $settlements->party_summary( $party_type, $provider_id ),
				'outstanding' => $settlements->outstanding_orders_for_party( $party_type, $provider_id ),
				'settlements' => array_slice( $settlements->for_party( $party_type, $provider_id ), 0, 20 ),
			]
		);
	}
}
