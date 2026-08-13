<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Rest;

use BeauClick\Analytics\Metrics\MetricsService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use WP_REST_Request;

/**
 * Two routes only, matching this step's actual scope:
 *
 * - GET /analytics/overview: the platform-wide admin dashboard's data
 *   source. Admin-only (bc_manage_platform) — analytics can reveal real
 *   business volume/revenue (§20/§22's own "analytics can contain sensitive
 *   business information" instruction), so this is not a customer- or
 *   professional-facing endpoint. A scoped "my own bookings/profile views"
 *   view for professionals is explicitly out of scope for Step 11 (§21 —
 *   "do not build a full BI product... if a professional-facing analytics
 *   UI belongs in a later step, document it") and is left as a documented
 *   future extension, not built here.
 *
 * - POST /analytics/track: the lightweight, strictly allow-listed
 *   UI-visibility ping (ai_assistant_opened/crm_opened/journey_opened) —
 *   any logged-in user may report their OWN view of their OWN session
 *   (actor is always the current user, never client-supplied), and only
 *   for the exact three event names on the allowlist. This is deliberately
 *   NOT a general "log any event" endpoint — that would let a client
 *   forge arbitrary analytics data.
 */
final class AnalyticsController extends RestController {

	private const TRACKABLE_EVENTS = [ 'ai_assistant_opened', 'crm_opened', 'journey_opened' ];

	public function register_routes(): void {
		$this->route(
			'/analytics/overview',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'overview' ],
				'permission_callback' => [ $this, 'require_admin' ],
			]
		);

		$this->route(
			'/analytics/track',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'track' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);
	}

	public function require_admin(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function overview( WP_REST_Request $request ): \WP_REST_Response {
		[ $from, $to ] = MetricsService::normalize_range(
			$request->get_param( 'from' ) ? (string) $request->get_param( 'from' ) : null,
			$request->get_param( 'to' ) ? (string) $request->get_param( 'to' ) : null
		);

		$service = new MetricsService();

		return Response::ok(
			[
				'range'       => [ 'from' => $from, 'to' => $to ],
				'overview'    => $service->overview( $from, $to ),
				'funnel'      => $service->funnel( $from, $to ),
				'commerce'    => $service->commerce( $from, $to ),
				'search'      => $service->search( $from, $to ),
				'ai'          => $service->ai( $from, $to ),
				'retention'   => $service->retention( $from, $to ),
				'usage'       => $service->usage( $from, $to ),
				'marketplace' => $service->marketplace( $from, $to ),
			]
		);
	}

	public function track( WP_REST_Request $request ): \WP_REST_Response {
		$event = (string) $request->get_param( 'event' );

		if ( ! in_array( $event, self::TRACKABLE_EVENTS, true ) ) {
			return Response::error( 'bc_invalid_event', __( 'رویداد نامعتبر است.', 'beauclick-analytics' ), 422 );
		}

		if ( function_exists( 'beauclick_core' ) ) {
			// entity_type 'ui', entity_id 0: these events describe the
			// current user opening a panel/tab, not an action on a specific
			// domain entity — there is nothing meaningful to put in entity_id.
			beauclick_core()->events()->log( $event, 'ui', 0, get_current_user_id() );
		}

		return Response::ok( [ 'tracked' => true ] );
	}
}
