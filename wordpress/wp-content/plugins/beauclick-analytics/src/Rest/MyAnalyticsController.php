<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Rest;

use BeauClick\Analytics\Metrics\MetricsService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * V2.2 Step 16 -- the professional/business-facing counterpart to
 * AnalyticsController::overview() (platform-admin, Step 11). Reuses the SAME
 * MetricsService, never a second analytics engine (this step's own explicit
 * requirement) -- the only new code is ownership resolution and scoping.
 *
 * "Which provider" is resolved from the current session only
 * (ProviderLookup::for_user(), falling back to StaffService for an
 * authorized staff member) -- never a client-supplied provider/business id,
 * so a professional/business can only ever see their own aggregates.
 */
final class MyAnalyticsController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/analytics/my/summary',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'summary' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);
	}

	/**
	 * Resolves the provider CPT post this user may see analytics for: direct
	 * ownership first (ProviderLookup, the canonical resolution everywhere
	 * else in this codebase), then active staff membership (V2.2 Step 16's
	 * own minimal staff model) -- see StaffService's own docblock for why
	 * this fallback is deliberately scoped to CRM/analytics only, not every
	 * ownership check in the codebase.
	 */
	private function resolve_provider_id( int $user_id ): ?int {
		$owned = ProviderLookup::for_user( $user_id );
		if ( $owned ) {
			return $owned;
		}
		if ( class_exists( '\BeauClick\Marketplace\Staff\StaffService' ) ) {
			$staff_of = ( new \BeauClick\Marketplace\Staff\StaffService() )->provider_ids_for_staff_user( $user_id );
			return $staff_of[0] ?? null;
		}
		return null;
	}

	public function summary( WP_REST_Request $request ): \WP_REST_Response {
		$user_id     = get_current_user_id();
		$provider_id = $this->resolve_provider_id( $user_id );

		if ( ! $provider_id ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-analytics' ), 404 );
		}

		$provider = get_post( $provider_id );
		if ( ! $provider ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-analytics' ), 404 );
		}

		[ $from, $to ] = MetricsService::normalize_range(
			$request->get_param( 'from' ) ? (string) $request->get_param( 'from' ) : null,
			$request->get_param( 'to' ) ? (string) $request->get_param( 'to' ) : null
		);

		$service = new MetricsService();
		$payload = [
			'range'      => [ 'from' => $from, 'to' => $to ],
			'providerId' => $provider_id,
			'postType'   => $provider->post_type,
			'metrics'    => $service->for_provider( $provider_id, $provider->post_type, $from, $to ),
			'b2b'        => $this->b2b_section( $user_id, $from, $to ),
		];

		return Response::ok( $payload );
	}

	/**
	 * B2B is a separate identity from the marketplace provider post (a
	 * wholesale buyer account, wp_bc_business_accounts, keyed by the same
	 * WP user id but not the same row as a bc_business CPT) -- confirmed
	 * during this step's own research. Deliberately optional and additive:
	 * beauclick-analytics never hard-depends on beauclick-b2b (matches the
	 * function_exists()/class_exists() cross-plugin-optionality convention
	 * every other module in this codebase already uses), and this section is
	 * simply absent (not an error) for a user with no approved B2B account.
	 * No revenue/financial figure is invented here -- only real counts
	 * already computed by beauclick-b2b's own QuoteService.
	 *
	 * @return array<string, mixed>|null
	 */
	private function b2b_section( int $user_id, string $from, string $to ): ?array {
		if ( ! class_exists( '\BeauClick\B2B\Business\BusinessAccountService' ) ) {
			return null;
		}
		$account_service = new \BeauClick\B2B\Business\BusinessAccountService();
		$account         = $account_service->find_by_user( $user_id );
		if ( ! $account || \BeauClick\B2B\Business\BusinessAccountService::STATUS_APPROVED !== $account['approval_status'] ) {
			return null;
		}

		$quotes = ( new \BeauClick\B2B\Business\QuoteService() )->for_business_account( (int) $account['id'] );

		$counts = [
			'requested' => 0,
			'quoted'    => 0,
			'accepted'  => 0,
			'expired'   => 0,
		];
		$accepted_order_ids = [];
		foreach ( $quotes as $quote ) {
			$status = (string) $quote['status'];
			if ( isset( $counts[ $status ] ) ) {
				++$counts[ $status ];
			}
			if ( 'accepted' === $status && ! empty( $quote['wc_order_id'] ) ) {
				$accepted_order_ids[] = (int) $quote['wc_order_id'];
			}
		}

		// "Gross order value", never "earnings" -- Financial/Payout (V2.3)
		// is what would define a real commission/receivable figure; this is
		// simply the sum of real WooCommerce order totals already created
		// from accepted quotes, labelled honestly per the task's own
		// "do not invent a revenue metric from incomplete financial data"
		// instruction.
		$gross_order_value = 0.0;
		if ( $accepted_order_ids && function_exists( 'wc_get_orders' ) ) {
			$orders = wc_get_orders( [ 'post__in' => $accepted_order_ids, 'limit' => -1, 'return' => 'objects' ] );
			foreach ( $orders as $order ) {
				$gross_order_value += (float) $order->get_total();
			}
		}

		return [
			'accountStatus'        => $account['approval_status'],
			'quoteCounts'          => $counts,
			'grossOrderValueLabel' => __( 'ارزش ناخالص سفارش‌های تأییدشده', 'beauclick-analytics' ),
			'grossOrderValue'      => $gross_order_value,
		];
	}
}
