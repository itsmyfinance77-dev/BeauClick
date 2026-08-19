<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Financial\SettlementService;
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

	/**
	 * V3_GAP_REGISTER.md GAP-05: this handler no longer resolves the party
	 * identity itself and threads it through to `SettlementService` --
	 * `my_party_summary()`/`my_outstanding_orders()` now do that resolution
	 * internally (see their own docblocks), so the isolation guarantee this
	 * route relies on lives on the data-access classes themselves, not only
	 * here. `for_party()`'s own settlement history listing is the one piece
	 * that still takes an explicit party_type/party_id -- both values are
	 * still resolved from the session only (never a request parameter),
	 * matching this controller's own pre-existing, still-correct discipline.
	 */
	public function summary( WP_REST_Request $request ): \WP_REST_Response {
		$settlements = new SettlementService();

		$party_summary = $settlements->my_party_summary();
		if ( null === $party_summary ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-financial' ), 404 );
		}

		return Response::ok(
			[
				'partyType'   => $party_summary['partyType'],
				'partyId'     => $party_summary['partyId'],
				'summary'     => $party_summary['summary'],
				'outstanding' => $settlements->my_outstanding_orders(),
				'settlements' => array_slice( $settlements->for_party( $party_summary['partyType'], $party_summary['partyId'] ), 0, 20 ),
			]
		);
	}
}
