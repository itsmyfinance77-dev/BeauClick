<?php
declare( strict_types=1 );

namespace BeauClick\Payments;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Payments\Booking\BookingOrderBridge;
use BeauClick\Payments\Database\Seeds\DemoProductsSeed;
use BeauClick\Payments\Product\ServiceProductSync;
use BeauClick\Payments\Rest\MyOrdersController;

final class Plugin {

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function boot(): void {
		( new ServiceProductSync() )->register();
		( new Currency() )->register();

		/**
		 * woocommerce_payment_complete fires specifically when a gateway
		 * confirms money actually moved — WooCommerce's own recommended hook
		 * for "payment succeeded", and gateway-agnostic (COD, bank transfer,
		 * or a real Iranian gateway later all fire it the same way). This is
		 * deliberately NOT the same as reacting to every status change: a
		 * generic woocommerce_order_status_changed firing to 'processing'
		 * can happen for reasons that aren't "payment succeeded" (e.g. manual
		 * admin status edits), which is exactly the "don't equate order
		 * status blindly with successful payment" gap flagged in review.
		 */
		add_action( 'woocommerce_payment_complete', [ $this, 'on_payment_complete' ] );

		// Failure/cancellation *is* well represented by status alone — there's
		// no equivalent single "payment failed" action as canonical as
		// payment_complete, and these statuses are unambiguous either way.
		add_action( 'woocommerce_order_status_cancelled', [ $this, 'on_order_dead' ] );
		add_action( 'woocommerce_order_status_failed', [ $this, 'on_order_dead' ] );
		add_action( 'woocommerce_order_status_refunded', [ $this, 'on_order_dead' ] );

		add_filter( 'beauclick/booking/after_create', [ $this, 'attach_order_to_booking_result' ], 10, 2 );
		add_action( 'beauclick/seed', [ $this, 'maybe_seed' ] );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
		add_action( 'woocommerce_review_order_before_submit', [ self::class, 'render_refund_policy_link' ] );
	}

	public function register_rest_routes(): void {
		( new MyOrdersController() )->register_routes();
	}

	public function maybe_seed( ?string $only ): void {
		if ( $only !== null && $only !== 'shop' ) {
			return;
		}
		DemoProductsSeed::run();
	}

	/**
	 * @param array{booking_id:int} $result
	 * @param array{booking_id:int, customer_id:int, provider_id:int, service_id:?int} $context
	 * @return array{booking_id:int, payUrl?:string}
	 */
	public function attach_order_to_booking_result( array $result, array $context ): array {
		$product = $this->resolve_service_product( $context['service_id'], $context['provider_id'] );

		$order = ( new BookingOrderBridge() )->create_order_for_booking(
			$context['booking_id'],
			$context['customer_id'],
			$product
		);

		$result['payUrl']  = $order->get_checkout_payment_url();
		// V2.1 Step 9: exposes the real order id to any later callback on
		// this same filter (e.g. beauclick-loyalty's MembershipDiscount,
		// which runs at a later priority) without that callback needing to
		// re-derive it from wp_bc_bookings itself.
		$result['orderId'] = $order->get_id();

		return $result;
	}

	private function resolve_service_product( ?int $service_id, int $provider_id ): \WC_Product {
		if ( $service_id ) {
			return ( new ServiceProductSync() )->sync( $service_id );
		}

		// Defensive fallback only — the booking modal always sends a
		// service_id in practice (step 1 requires selecting one). A
		// malformed/legacy request without one still gets a valid,
		// hidden, ad-hoc product rather than a fatal error.
		$provider = get_post( $provider_id );
		$product  = new \WC_Product_Simple();
		$product->set_name( $provider ? sprintf( /* translators: %s: provider name */ __( 'رزرو نوبت با %s', 'beauclick-payments' ), $provider->post_title ) : __( 'رزرو نوبت', 'beauclick-payments' ) );
		$product->set_virtual( true );
		$product->set_catalog_visibility( 'hidden' );
		$product->set_status( 'publish' );
		$product->save();

		return $product;
	}

	public function on_payment_complete( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}

		$customer_id = (int) $order->get_customer_id() ?: null;

		// V2.0 Step 1: order_completed applies to every paid order (booking
		// or a real Shop/B2B purchase alike) — genuinely useful analytics
		// either way. Guarded with has_logged() because, unlike the booking
		// status transitions elsewhere in this file, woocommerce_payment_
		// complete has no atomic single-fire guarantee of its own — some
		// gateway/webhook-retry paths can re-fire it for the same order.
		if ( function_exists( 'beauclick_core' ) && ! beauclick_core()->events()->has_logged( 'order_completed', 'order', $order_id ) ) {
			beauclick_core()->events()->log( 'order_completed', 'order', $order_id, $customer_id, [ 'total' => (float) $order->get_total() ] );
		}

		$booking_id = ( new BookingOrderBridge() )->find_booking_id_for_order( $order );

		if ( ! $booking_id ) {
			// Not a booking-originated order — a real Shop/B2B purchase, and
			// the loyalty-earning hook seam for it (see beauclick-loyalty\
			// EarningRules). Deliberately not fired for a booking's own
			// linked order: that payment is what unlocks booking_completed's
			// award later once the service is actually delivered, and
			// awarding both would double-count one real transaction.
			do_action( 'beauclick/payments/shop_order_completed', $order_id, (int) $order->get_customer_id() );
			return;
		}

		if ( ( new BookingService() )->confirm_booking( $booking_id ) ) {
			return;
		}

		$this->handle_paid_but_unconfirmable_booking( $order, $booking_id );
	}

	public function on_order_dead( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}

		// V2.0 Step 1: order_refunded, scoped to the genuinely-refunded
		// status only (this handler also covers cancelled/failed, which
		// aren't refund events). Same has_logged() guard as order_completed
		// above, for the same reason — no atomic single-fire guarantee
		// upstream.
		if ( 'refunded' === $order->get_status() && function_exists( 'beauclick_core' ) && ! beauclick_core()->events()->has_logged( 'order_refunded', 'order', $order_id ) ) {
			beauclick_core()->events()->log( 'order_refunded', 'order', $order_id, (int) $order->get_customer_id() ?: null, [ 'total' => (float) $order->get_total() ] );
		}

		$booking_id = ( new BookingOrderBridge() )->find_booking_id_for_order( $order );
		if ( ! $booking_id ) {
			return;
		}

		( new BookingService() )->cancel_booking( $booking_id, 'wc_order_' . $order->get_status() );
	}

	/**
	 * Payment legitimately succeeded, but confirm_booking() refused — the
	 * hold expired (and the sweep already cancelled the booking record)
	 * before payment completed, or something else raced it out of
	 * 'pending'. The customer was charged for a slot BeauClick can no
	 * longer honor; the only correct response is to give the money back
	 * automatically where the gateway supports it, and leave an
	 * unmistakable order note either way so this never silently
	 * disappears.
	 */
	private function handle_paid_but_unconfirmable_booking( \WC_Order $order, int $booking_id ): void {
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'booking_confirm_after_expiry_conflict', 'booking', $booking_id, null, [ 'order_id' => $order->get_id() ] );
		}

		// wc_can_order_be_refunded() is not a real WooCommerce function (there
		// is no such public helper — refund eligibility lives inside the REST
		// orders controller, not a reusable global); attempt the refund
		// directly and branch on the result instead of a pre-check that
		// doesn't exist.
		if ( (float) $order->get_total() > 0 ) {
			$refund = wc_create_refund(
				[
					'order_id' => $order->get_id(),
					'amount'   => $order->get_total(),
					'reason'   => __( 'زمان رزرو قبل از تکمیل پرداخت منقضی شد و توسط مشتری دیگری رزرو گردید — بازگشت خودکار وجه.', 'beauclick-payments' ),
				]
			);

			if ( is_wp_error( $refund ) ) {
				$order->add_order_note( __( 'رزرو مرتبط دیگر معتبر نیست و بازگشت خودکار وجه ناموفق بود — نیاز به بررسی دستی.', 'beauclick-payments' ) );
			} else {
				$order->add_order_note( __( 'رزرو مرتبط منقضی شده بود؛ وجه به‌صورت خودکار بازگردانده شد.', 'beauclick-payments' ) );
			}
		} else {
			$order->add_order_note( __( 'رزرو مرتبط دیگر معتبر نیست — مبلغ سفارش صفر بود، نیازی به بازگشت وجه نیست.', 'beauclick-payments' ) );
		}
	}

	/**
	 * Enables WooCommerce's built-in Cash on Delivery gateway, clearly
	 * relabelled as a local-development/testing stand-in, so the full
	 * booking -> order -> payment -> confirmation loop is exercisable
	 * end-to-end without real gateway credentials (none are available, and
	 * none belong in this repository regardless — architecture doc §16/§29:
	 * swapping in a real Iranian gateway later is enabling that gateway's
	 * own plugin, zero changes to this bridge). Idempotent: only touches
	 * settings that differ from the desired state, safe to call repeatedly.
	 *
	 * Gated on wp_get_environment_type() — a production-readiness audit
	 * flagged that the "local development only" label was UI text only,
	 * with no actual mechanism stopping a production activation (or
	 * reactivation, e.g. during a redeploy) from silently turning on an
	 * unauthenticated "payment succeeded" path with no real money
	 * verification behind it. wp_get_environment_type() defaults to
	 * 'production' when WP_ENVIRONMENT_TYPE isn't set (see
	 * bootstrap-env.php), so a production deploy is safe by default even
	 * if nobody remembers to configure this explicitly.
	 */
	public static function activate(): void {
		if ( ! class_exists( 'WC_Payment_Gateways' ) ) {
			return;
		}

		Currency::ensure_configured(); // Every environment, not just non-production — unlike COD, correct currency formatting is never dev-only.
		self::ensure_persian_page_titles();
		self::ensure_persian_checkout_privacy_text();
		self::ensure_terms_page_configured();

		if ( 'production' === wp_get_environment_type() ) {
			self::ensure_store_is_reachable();
			self::ensure_classic_checkout();
			return;
		}

		$settings = get_option( 'woocommerce_cod_settings', [] );
		$desired  = [
			'enabled'      => 'yes',
			'title'        => __( 'پرداخت نقدی هنگام دریافت خدمت (فقط توسعه محلی)', 'beauclick-payments' ),
			'description'  => __( 'این روش پرداخت صرفاً برای تست محلی فعال است و نباید در محیط عملیاتی بدون یک درگاه واقعی استفاده شود.', 'beauclick-payments' ),
			'instructions' => __( 'این یک روش پرداخت آزمایشی است.', 'beauclick-payments' ),
		];

		if ( array_intersect_key( $desired, $settings ) !== $desired ) {
			update_option( 'woocommerce_cod_settings', array_merge( $settings, $desired ) );
		}

		self::ensure_store_is_reachable();
		self::ensure_classic_checkout();
	}

	/**
	 * WooCommerce ships new installs with "Coming soon" mode on for store
	 * pages (Shop/Cart/Checkout/Product return a placeholder instead of
	 * real content) — harmless in itself, but it silently intercepts the
	 * booking payment redirect too, since order-pay/order-received are
	 * store-scoped URLs. A fresh environment would otherwise 404-equivalent
	 * on the exact page the booking flow depends on, with no obvious cause.
	 */
	private static function ensure_store_is_reachable(): void {
		if ( 'yes' === get_option( 'woocommerce_coming_soon' ) ) {
			update_option( 'woocommerce_coming_soon', 'no' );
		}
	}

	/**
	 * WooCommerce auto-creates Shop/Cart/Checkout/My account with English
	 * titles the moment it's installed, regardless of the site's locale
	 * setting — a production-readiness audit found this was the one visible
	 * English leftover after fixing the locale itself (Core::
	 * ensure_site_locale()): the page CONTENT translated correctly (real
	 * i18n via .mo files), but these titles are literal post_title data
	 * written once at creation time, not something a locale change touches
	 * retroactively. Only overwrites WooCommerce's own stock English
	 * titles — never touches a title an admin already customized (matches
	 * the array key check "is this still the untouched original value").
	 */
	private static function ensure_persian_page_titles(): void {
		if ( ! function_exists( 'wc_get_page_id' ) ) {
			return;
		}

		$desired = [
			'shop'       => [ 'Shop', 'فروشگاه' ],
			'cart'       => [ 'Cart', 'سبد خرید' ],
			'checkout'   => [ 'Checkout', 'پرداخت' ],
			'myaccount'  => [ 'My account', 'حساب کاربری' ],
		];

		foreach ( $desired as $page_slug => [ $stock_title, $persian_title ] ) {
			$page_id = wc_get_page_id( $page_slug );
			if ( $page_id <= 0 ) {
				continue;
			}
			$page = get_post( $page_id );
			if ( $page && $stock_title === $page->post_title ) {
				wp_update_post( [ 'ID' => $page_id, 'post_title' => $persian_title ] );
			}
		}
	}

	/**
	 * Global date/error localization audit: WooCommerce's checkout privacy
	 * notice ("Your personal data will be used to process your order...")
	 * is stored as a literal option value at install time
	 * (`woocommerce_checkout_privacy_policy_text`), not translated live via
	 * .mo files the way most WooCommerce strings are — so it stays in
	 * English forever regardless of the site locale unless something
	 * explicitly rewrites it, exactly the class of leak found on the real
	 * "pay for order" page during this audit's live verification. Same
	 * "only touch it if it's still the untouched stock default" discipline
	 * as ensure_persian_page_titles() — an admin who already customized
	 * this text is never overwritten.
	 */
	private static function ensure_persian_checkout_privacy_text(): void {
		// Deliberately the raw English literal, NOT __('...', 'woocommerce')
		// -- this site's locale is already fa_IR, so calling __() here would
		// itself return the *translated* string (WooCommerce's fa_IR.mo does
		// cover it) and could never match the stored option's literal
		// English text, which was written once at install/setup-wizard time
		// (before/independent of the active locale) and never re-translated
		// on read. Comparing against the raw literal is the only way to
		// actually detect "still the untouched stock default."
		$stock_default = 'Your personal data will be used to process your order, support your experience throughout this website, and for other purposes described in our [privacy_policy].';

		$current = get_option( 'woocommerce_checkout_privacy_policy_text', $stock_default );
		if ( $current !== $stock_default ) {
			return; // Already customized (by an admin, or a prior real translation) — never overwrite.
		}

		update_option(
			'woocommerce_checkout_privacy_policy_text',
			__( 'اطلاعات شخصی شما برای پردازش سفارش، بهبود تجربه شما در این وبسایت، و سایر مواردی که در [privacy_policy] توضیح داده شده استفاده خواهد شد.', 'beauclick-payments' )
		);
	}

	/**
	 * V2.1 Step 7 — WooCommerce only ever renders its own built-in
	 * "I have read and agree to the terms and conditions" checkout
	 * checkbox when `woocommerce_terms_page_id` points at a genuinely
	 * *published* page (`wc_terms_and_conditions_page_id()` internally
	 * checks post_status) — reusing this native mechanism is exactly what
	 * the task asks for ("do not override WooCommerce checkout
	 * unnecessarily... use stable hooks and filters") instead of building
	 * a second, custom consent checkbox.
	 *
	 * Deliberately a no-op today: `LegalPages::ensure()` (beauclick-core)
	 * creates the Terms page as a draft on purpose — its binding legal
	 * clauses are not yet reviewed (see that class's own docblock) — so
	 * this intentionally does not wire the option until a real admin
	 * publishes that page. Never points the option at a draft.
	 */
	private static function ensure_terms_page_configured(): void {
		$page = get_page_by_path( 'terms', OBJECT, 'page' );
		if ( ! $page || 'publish' !== $page->post_status ) {
			return;
		}
		if ( (int) get_option( 'woocommerce_terms_page_id' ) === 0 ) {
			update_option( 'woocommerce_terms_page_id', $page->ID );
		}
	}

	/**
	 * A real, honest refund-policy link at the one point in checkout a
	 * customer is about to commit to a payment — `woocommerce_review_order_before_submit`
	 * is WooCommerce's own stable hook for exactly this, right above the
	 * "Place order" button, so no template override is needed.
	 */
	public static function render_refund_policy_link(): void {
		$page = get_page_by_path( 'refund_returns', OBJECT, 'page' );
		if ( ! $page || 'publish' !== $page->post_status ) {
			return;
		}
		printf(
			'<p class="bc-checkout-refund-link" style="font-size:12px;margin:8px 0;"><a href="%1$s">%2$s</a></p>',
			esc_url( get_permalink( $page ) ),
			esc_html__( 'قوانین لغو و بازگشت وجه را بخوانید', 'beauclick-payments' )
		);
	}

	/**
	 * WooCommerce defaults new installs' Cart/Checkout pages to the
	 * block-based editor experience ([wp:woocommerce/checkout] etc.), which
	 * renders entirely client-side and does not go through wc_get_template()
	 * at all — the theme's woocommerce/checkout/thankyou.php override (and
	 * any future classic template override) would silently never run.
	 * Classic shortcode pages give this project full server-rendered
	 * control over checkout's visual identity (review point #6), consistent
	 * with every other page in the theme, rather than re-theming WooCommerce's
	 * React checkout blocks purely through CSS overrides.
	 */
	private static function ensure_classic_checkout(): void {
		if ( ! function_exists( 'wc_get_page_id' ) ) {
			return;
		}

		$pages = [
			'cart'     => '[woocommerce_cart]',
			'checkout' => '[woocommerce_checkout]',
		];

		foreach ( $pages as $page_slug => $shortcode ) {
			$page_id = wc_get_page_id( $page_slug );
			if ( $page_id <= 0 ) {
				continue;
			}
			$page = get_post( $page_id );
			if ( $page && ! str_contains( (string) $page->post_content, $shortcode ) ) {
				wp_update_post( [ 'ID' => $page_id, 'post_content' => $shortcode ] );
			}
		}
	}
}
