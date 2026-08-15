<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Rest;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Business\QuoteService;
use BeauClick\B2B\Pricing\TierPricingEngine;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use WP_REST_Request;

final class B2BController extends RestController {

	public function register_routes(): void {
		$this->route( '/b2b/account', [ 'methods' => 'GET', 'callback' => [ $this, 'get_account' ], 'permission_callback' => [ $this, 'require_login' ] ] );

		$this->route(
			'/b2b/apply',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'apply' ],
				'permission_callback' => [ $this, 'require_login' ],
				'args'                => [
					'business_name' => [ 'type' => 'string', 'required' => true ],
					'license'       => [ 'type' => 'string', 'required' => false ],
					'phone'         => [ 'type' => 'string', 'required' => false ],
				],
			]
		);

		$this->route(
			'/b2b/pricing/(?P<product_id>\d+)',
			[ 'methods' => 'GET', 'callback' => [ $this, 'get_pricing' ], 'permission_callback' => '__return_true' ]
		);

		$this->route(
			'/b2b/quotes',
			[
				[ 'methods' => 'GET', 'callback' => [ $this, 'list_quotes' ], 'permission_callback' => [ $this, 'require_approved_business' ] ],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'request_quote' ],
					'permission_callback' => [ $this, 'require_approved_business' ],
					'args'                => [ 'items' => [ 'type' => 'array', 'required' => true ] ],
				],
			]
		);

		$this->route(
			'/b2b/quotes/(?P<id>\d+)/accept',
			[ 'methods' => 'POST', 'callback' => [ $this, 'accept_quote' ], 'permission_callback' => [ $this, 'require_approved_business' ] ]
		);

		// Admin/moderation.
		$this->route(
			'/b2b/accounts/pending',
			[ 'methods' => 'GET', 'callback' => [ $this, 'list_pending_accounts' ], 'permission_callback' => [ $this, 'require_admin' ] ]
		);
		$this->route(
			'/b2b/accounts/(?P<id>\d+)/approve',
			[ 'methods' => 'POST', 'callback' => [ $this, 'approve_account' ], 'permission_callback' => [ $this, 'require_admin' ] ]
		);
		$this->route(
			'/b2b/accounts/(?P<id>\d+)/reject',
			[ 'methods' => 'POST', 'callback' => [ $this, 'reject_account' ], 'permission_callback' => [ $this, 'require_admin' ] ]
		);
		$this->route(
			'/b2b/quotes/(?P<id>\d+)/quote',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'submit_quote_prices' ],
				'permission_callback' => [ $this, 'require_admin' ],
				'args'                => [ 'items' => [ 'type' => 'array', 'required' => true ] ],
			]
		);

		$this->route(
			'/b2b/tiers/(?P<product_id>\d+)',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'set_tiers' ],
				'permission_callback' => [ $this, 'require_admin' ],
				'args'                => [ 'tiers' => [ 'type' => 'array', 'required' => true ] ],
			]
		);
	}

	public function require_admin(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function require_approved_business(): bool|\WP_Error {
		$login_check = $this->require_login();
		if ( true !== $login_check ) {
			return $login_check;
		}
		if ( ( new BusinessAccountService() )->is_approved( get_current_user_id() ) ) {
			return true;
		}
		return new \WP_Error( 'bc_not_approved_business', __( 'حساب شما هنوز به‌عنوان خریدار عمده تأیید نشده است.', 'beauclick-b2b' ), [ 'status' => 403 ] );
	}

	public function get_account(): \WP_REST_Response {
		$account = ( new BusinessAccountService() )->find_by_user( get_current_user_id() );
		return Response::ok( $account ?: null );
	}

	public function apply( WP_REST_Request $request ): \WP_REST_Response {
		$id = ( new BusinessAccountService() )->apply(
			get_current_user_id(),
			sanitize_text_field( (string) $request->get_param( 'business_name' ) ),
			$request->get_param( 'license' ) ? sanitize_text_field( (string) $request->get_param( 'license' ) ) : null,
			$request->get_param( 'phone' ) ? sanitize_text_field( (string) $request->get_param( 'phone' ) ) : null
		);
		return Response::ok( [ 'accountId' => $id ], [], 201 );
	}

	public function get_pricing( WP_REST_Request $request ): \WP_REST_Response {
		$engine     = new TierPricingEngine();
		$product_id = (int) $request->get_param( 'product_id' );
		return Response::ok(
			[
				'tiers' => $engine->get_tiers( $product_id ),
				'moq'   => $engine->moq( $product_id ),
			]
		);
	}

	public function request_quote( WP_REST_Request $request ): \WP_REST_Response {
		$account = ( new BusinessAccountService() )->find_by_user( get_current_user_id() );
		$items   = array_map(
			static fn ( array $i ) => [ 'product_id' => (int) $i['product_id'], 'quantity' => max( 1, (int) $i['quantity'] ) ],
			(array) $request->get_param( 'items' )
		);

		if ( ! $items ) {
			return Response::error( 'bc_empty_quote', __( 'حداقل یک محصول برای درخواست پیش‌فاکتور لازم است.', 'beauclick-b2b' ), 400 );
		}

		$id = ( new QuoteService() )->request( (int) $account['id'], $items );
		return Response::ok( [ 'quoteId' => $id ], [], 201 );
	}

	public function list_quotes(): \WP_REST_Response {
		$account = ( new BusinessAccountService() )->find_by_user( get_current_user_id() );
		return Response::ok( ( new QuoteService() )->for_business_account( (int) $account['id'] ) );
	}

	public function accept_quote( WP_REST_Request $request ): \WP_REST_Response {
		$account = ( new BusinessAccountService() )->find_by_user( get_current_user_id() );
		if ( ! $account ) {
			return Response::error( 'bc_quote_not_acceptable', __( 'این پیش‌فاکتور دیگر قابل تأیید نیست.', 'beauclick-b2b' ), 409 );
		}

		$order = ( new QuoteService() )->accept( (int) $request->get_param( 'id' ), (int) $account['id'], get_current_user_id() );
		if ( ! $order ) {
			return Response::error( 'bc_quote_not_acceptable', __( 'این پیش‌فاکتور دیگر قابل تأیید نیست.', 'beauclick-b2b' ), 409 );
		}
		return Response::ok( [ 'orderId' => $order->get_id(), 'payUrl' => $order->get_checkout_payment_url() ] );
	}

	public function list_pending_accounts(): \WP_REST_Response {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_business_accounts WHERE approval_status = 'pending' ORDER BY created_at ASC", ARRAY_A );
		return Response::ok( $rows ?: [] );
	}

	/**
	 * V2.3 Step 20 (ADMIN-05): this REST route reaches the exact same
	 * approve/reject action as AccountsAdminPage's wp-admin form, but was
	 * never wired to AuditLogger — a real, reachable, admin-permission-gated
	 * path that bypassed the audit trail. Logs with the same action_type/
	 * entity_type/before-after shape AccountsAdminPage::approve_and_log()
	 * uses, so the audit log reads identically regardless of which path was
	 * used.
	 */
	public function approve_account( WP_REST_Request $request ): \WP_REST_Response {
		$account_id = (int) $request->get_param( 'id' );
		$before     = $this->account_status( $account_id );
		( new BusinessAccountService() )->approve( $account_id );
		$this->log_account_status_change( 'b2b_account_approved', $account_id, $before, BusinessAccountService::STATUS_APPROVED );
		return Response::ok( [ 'approved' => true ] );
	}

	/**
	 * Deliberately does not delegate to AccountsAdminPage::reject_and_log()
	 * — that method hardcodes a default Persian rejection reason for the
	 * wp-admin form (which has no reason field), while this REST route
	 * already accepts a real caller-supplied `reason`. Logging must record
	 * the reason actually given, not silently overwrite it.
	 */
	public function reject_account( WP_REST_Request $request ): \WP_REST_Response {
		$account_id = (int) $request->get_param( 'id' );
		$reason     = (string) $request->get_param( 'reason' );
		$before     = $this->account_status( $account_id );
		( new BusinessAccountService() )->reject( $account_id, $reason );
		$this->log_account_status_change( 'b2b_account_rejected', $account_id, $before, BusinessAccountService::STATUS_REJECTED, $reason );
		return Response::ok( [ 'rejected' => true ] );
	}

	/** @return array<string, mixed>|null */
	private function account_status( int $account_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT approval_status FROM {$wpdb->prefix}bc_business_accounts WHERE id = %d", $account_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	private function log_account_status_change( string $action_type, int $account_id, ?array $before, string $new_status, ?string $reason = null ): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->audit_log()->record(
			$action_type,
			'business_account',
			$account_id,
			get_current_user_id(),
			$before,
			[ 'approval_status' => $new_status ],
			$reason
		);
	}

	public function submit_quote_prices( WP_REST_Request $request ): \WP_REST_Response {
		$items = array_map(
			static fn ( array $i ) => [ 'product_id' => (int) $i['product_id'], 'quantity' => (int) $i['quantity'], 'price' => (int) $i['price'] ],
			(array) $request->get_param( 'items' )
		);
		$ok = ( new QuoteService() )->submit_quote_prices( (int) $request->get_param( 'id' ), $items, $request->get_param( 'expires_at' ) );
		return $ok ? Response::ok( [ 'quoted' => true ] ) : Response::error( 'bc_cannot_quote', __( 'این درخواست دیگر قابل قیمت‌گذاری نیست.', 'beauclick-b2b' ), 409 );
	}

	public function set_tiers( WP_REST_Request $request ): \WP_REST_Response {
		$tiers = array_map(
			static fn ( array $t ) => [
				'min_qty'        => (int) $t['min_qty'],
				'max_qty'        => isset( $t['max_qty'] ) ? (int) $t['max_qty'] : null,
				'price'          => (int) $t['price'],
				'is_recommended' => ! empty( $t['is_recommended'] ),
			],
			(array) $request->get_param( 'tiers' )
		);
		( new TierPricingEngine() )->set_tiers( (int) $request->get_param( 'product_id' ), $tiers );
		return Response::ok( [ 'saved' => true ] );
	}
}
