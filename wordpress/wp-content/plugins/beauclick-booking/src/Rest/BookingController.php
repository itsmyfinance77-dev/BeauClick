<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Rest;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

final class BookingController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/booking/availability',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'availability' ],
				'permission_callback' => '__return_true',
				'args'                => [
					'provider_id' => [ 'type' => 'integer', 'required' => true ],
					'date'        => [ 'type' => 'string', 'required' => false ], // YYYY-MM-DD; omitted = next 7 days.
				],
			]
		);

		$this->route(
			'/booking/bookings',
			[
				[
					'methods'             => 'GET',
					'callback'            => [ $this, 'list_own' ],
					'permission_callback' => [ $this, 'require_login' ],
				],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'create' ],
					'permission_callback' => [ $this, 'can_book' ],
					'args'                => [
						'provider_id' => [ 'type' => 'integer', 'required' => true ],
						'slot_id'     => [ 'type' => 'integer', 'required' => true ],
						'service_id'  => [ 'type' => 'integer', 'required' => false ],
					],
				],
			]
		);

		$this->route(
			'/booking/bookings/(?P<id>\d+)/cancel',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'cancel' ],
				'permission_callback' => [ $this, 'require_login' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);

		$this->route(
			'/booking/bookings/(?P<id>\d+)/confirm',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'confirm' ],
				// Temporary manual path until beauclick-payments (Phase 6)
				// auto-confirms on a paid WooCommerce order; gated to the
				// owning provider or an admin/platform capability so it's
				// never callable by an arbitrary logged-in customer.
				'permission_callback' => [ $this, 'can_confirm' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);

		$this->route(
			'/booking/bookings/(?P<id>\d+)/no-show',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'no_show' ],
				// Same ownership gate as confirm() -- the owning provider or an admin/platform capability, never an arbitrary customer.
				'permission_callback' => [ $this, 'can_confirm' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	public function can_book(): bool|\WP_Error {
		return $this->require_capability( 'bc_book_service' );
	}

	/**
	 * `bc_bookings.provider_id` is the professional's CPT post id, not their
	 * WP user id (see ProviderLookup) — require_owner_or_capability() can't
	 * be used directly here the way it is elsewhere, since it compares
	 * against get_current_user_id(), not against the current user's own
	 * provider post id.
	 */
	public function can_confirm( WP_REST_Request $request ): bool|\WP_Error {
		$booking = ( new BookingService() )->find( (int) $request->get_param( 'id' ) );
		if ( ! $booking ) {
			return true; // Let the handler 404 — permission isn't the interesting failure here.
		}
		$my_provider_id = ProviderLookup::for_user( get_current_user_id() );
		if ( $my_provider_id && $my_provider_id === (int) $booking['provider_id'] ) {
			return true;
		}
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function availability( WP_REST_Request $request ) {
		global $wpdb;
		$provider_id = (int) $request->get_param( 'provider_id' );
		$date        = $request->get_param( 'date' );
		$now         = current_time( 'mysql' ); // Site-local — see the note below on why the 7-day upper bound must derive from this, not time().

		$where  = [ 'provider_id = %d', "status = 'open'", 'start_at >= %s' ];
		$params = [ $provider_id, $date ? "{$date} 00:00:00" : $now ];

		if ( $date ) {
			$where[]  = 'start_at < %s';
			$params[] = gmdate( 'Y-m-d', strtotime( $date ) + DAY_IN_SECONDS ) . ' 00:00:00';
		} else {
			// A production-readiness audit caught this mixing time() (true
			// UTC) with current_time('mysql') (site-local) as the lower
			// bound above — once the site timezone is set away from UTC
			// (Iran is UTC+3:30), the two bounds of this "next 7 days"
			// window would be offset from each other by exactly that much,
			// clipping or extending the window unpredictably right at its
			// edges. Deriving both from the same $now (naive site-local
			// arithmetic, the idiom used everywhere else in this module —
			// see BookingService) keeps them consistent.
			$where[]  = 'start_at < %s';
			$params[] = gmdate( 'Y-m-d H:i:s', strtotime( $now ) + 7 * DAY_IN_SECONDS );
		}

		$sql  = 'SELECT id, service_id, start_at, end_at FROM ' . $wpdb->prefix . 'bc_availability_slots WHERE ' . implode( ' AND ', $where ) . ' ORDER BY start_at ASC';
		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		return Response::ok(
			array_map(
				static fn ( array $r ) => [
					'id'        => (int) $r['id'],
					'serviceId' => $r['service_id'] ? (int) $r['service_id'] : null,
					'startAt'   => $r['start_at'],
					'endAt'     => $r['end_at'],
				],
				$rows ?: []
			)
		);
	}

	public function create( WP_REST_Request $request ) {
		$customer_id = get_current_user_id();
		$provider_id = (int) $request->get_param( 'provider_id' );
		$service_id  = $request->get_param( 'service_id' ) ? (int) $request->get_param( 'service_id' ) : null;

		$result = ( new BookingService() )->create_booking( $customer_id, $provider_id, (int) $request->get_param( 'slot_id' ), $service_id );

		if ( false === $result ) {
			return Response::error( 'bc_too_many_holds', __( 'شما چند رزرو در انتظار پرداخت دارید — ابتدا آن‌ها را تکمیل یا لغو کنید.', 'beauclick-booking' ), 429 );
		}
		if ( null === $result ) {
			return Response::error( 'bc_slot_unavailable', __( 'این زمان دیگر در دسترس نیست — لطفاً زمان دیگری انتخاب کنید.', 'beauclick-booking' ), 409 );
		}

		/**
		 * Lets beauclick-payments attach a WooCommerce order + payUrl to the
		 * response without beauclick-booking needing to know WooCommerce (or
		 * even beauclick-payments) exists — the dependency points one way
		 * (payments depends on booking), same as every other cross-module
		 * seam in this codebase. If beauclick-payments isn't active, $result
		 * passes through unchanged and the booking is simply created without
		 * a payment step (useful for local testing without Woo configured).
		 */
		$result = apply_filters(
			'beauclick/booking/after_create',
			$result,
			[
				'booking_id'  => $result['booking_id'],
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'service_id'  => $service_id,
			]
		);

		return Response::ok( $result, [], 201 );
	}

	/**
	 * A production-readiness audit flagged this as an unbounded query — a
	 * long-tenured customer's or busy professional's entire booking history
	 * was returned on every dashboard load. Paginated the same way
	 * MarketplaceController::browse() already is; api.get<T>() unwraps the
	 * `data` array and silently drops the added `meta.pagination`, so no
	 * frontend caller needed to change.
	 */
	public function list_own( WP_REST_Request $request ) {
		global $wpdb;
		[ $page, $per_page ] = $this->pagination_args( $request, 20, 100 );
		$offset      = ( $page - 1 ) * $per_page;
		$user_id     = get_current_user_id();
		$provider_id = ProviderLookup::for_user( $user_id );

		if ( $provider_id ) {
			$where  = 'customer_id = %d OR provider_id = %d';
			$params = [ $user_id, $provider_id ];
		} else {
			$where  = 'customer_id = %d';
			$params = [ $user_id ];
		}

		$total = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_bookings WHERE {$where}", $params ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_bookings WHERE {$where} ORDER BY slot_start DESC LIMIT %d OFFSET %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( $params, [ $per_page, $offset ] )
			),
			ARRAY_A
		);

		return Response::paginated( array_map( [ $this, 'format_booking' ], $rows ?: [] ), $total, $page, $per_page );
	}

	public function cancel( WP_REST_Request $request ) {
		$service = new BookingService();
		$booking = $service->find( (int) $request->get_param( 'id' ) );

		if ( ! $booking ) {
			return Response::error( 'bc_not_found', __( 'رزرو پیدا نشد.', 'beauclick-booking' ), 404 );
		}

		$user_id        = get_current_user_id();
		$my_provider_id = ProviderLookup::for_user( $user_id );
		$is_provider    = $my_provider_id && $my_provider_id === (int) $booking['provider_id'];

		if ( (int) $booking['customer_id'] !== $user_id && ! $is_provider && ! current_user_can( 'bc_manage_platform' ) ) {
			return Response::error( 'bc_forbidden', __( 'شما اجازه لغو این رزرو را ندارید.', 'beauclick-booking' ), 403 );
		}

		$ok = $service->cancel_booking( (int) $booking['id'], (string) $request->get_param( 'reason' ) );

		return $ok
			? Response::ok( [ 'cancelled' => true ] )
			: Response::error( 'bc_cannot_cancel', __( 'این رزرو دیگر قابل لغو نیست.', 'beauclick-booking' ), 409 );
	}

	public function confirm( WP_REST_Request $request ) {
		$ok = ( new BookingService() )->confirm_booking( (int) $request->get_param( 'id' ) );
		return $ok
			? Response::ok( [ 'confirmed' => true ] )
			: Response::error( 'bc_cannot_confirm', __( 'این رزرو در وضعیت قابل تأیید نیست.', 'beauclick-booking' ), 409 );
	}

	public function no_show( WP_REST_Request $request ) {
		$ok = ( new BookingService() )->mark_no_show( (int) $request->get_param( 'id' ) );
		return $ok
			? Response::ok( [ 'noShow' => true ] )
			: Response::error( 'bc_cannot_mark_no_show', __( 'این رزرو در وضعیت قابل ثبت به‌عنوان عدم حضور نیست.', 'beauclick-booking' ), 409 );
	}

	private function format_booking( array $row ): array {
		return [
			'id'          => (int) $row['id'],
			'providerId'  => (int) $row['provider_id'],
			'customerId'  => (int) $row['customer_id'],
			'serviceId'   => $row['service_id'] ? (int) $row['service_id'] : null,
			'slotStart'   => $row['slot_start'],
			'slotEnd'     => $row['slot_end'],
			'status'      => $row['status'],
		];
	}
}
