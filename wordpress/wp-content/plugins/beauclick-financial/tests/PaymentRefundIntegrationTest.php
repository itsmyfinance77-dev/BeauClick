<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Campaigns\CampaignService;
use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use BeauClick\Financial\SettlementService;
use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

/**
 * End-to-end paths through the real cross-plugin hook seams -- the real
 * risk this step's own financial-correctness requirement cares about,
 * mirroring `LoyaltyIntegrationTest`/`CampaignDiscountIntegrationTest`'s own
 * discipline (V2.1 Step 9, V2.3 Step 17). Deliberately never registers any
 * `Recording\*`/hook class itself -- the real plugin bootstrap already
 * registers every hook exactly once for the whole test run.
 */
final class PaymentRefundIntegrationTest extends WP_UnitTestCase {

	public function set_up(): void {
		parent::set_up();
		CommissionConfig::set_rate( 15 );
	}

	private function make_open_slot( int $provider_id, string $start = '2027-09-01 10:00:00', string $end = '2027-09-01 11:00:00' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => $start, 'end_at' => $end, 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	private function make_priced_service( int $provider_post_id, int $price ): int {
		return self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_post_id, 'meta_input' => [ '_bc_price' => $price, '_bc_duration_minutes' => 60 ] ]
		);
	}

	private function make_provider( string $post_type = Registrar::PROFESSIONAL ): int {
		$owner = self::factory()->user->create();
		return self::factory()->post->create( [ 'post_type' => $post_type, 'post_status' => 'publish', 'post_author' => $owner ] );
	}

	// 1. A real booking payment records exactly the expected commission + receivable, derived from the REAL order total.
	public function test_a_real_booking_payment_records_correct_ledger_entries(): void {
		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 1000000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post );

		// A REAL wp_bc_bookings row is required -- PaymentRecorder resolves
		// ownership by looking the booking_id up in that table (all it has
		// at payment-complete time is the order's own _bc_booking_id meta,
		// not the original request context), so a fabricated booking_id
		// with no real row is correctly, safely ignored -- exactly what a
		// real customer-created booking never does.
		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$result  = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$order = wc_get_order( $result['orderId'] );
		$order->payment_complete();

		$ledger  = new LedgerService();
		$entries = $ledger->for_order( $result['orderId'] );
		$this->assertCount( 2, $entries );
		$this->assertSame( 850000, $ledger->party_receivable_net( LedgerService::PARTY_PROFESSIONAL, $provider_post ) );
	}

	// 2. A business's booking order is correctly attributed to party_type='business', never 'professional'.
	public function test_a_business_booking_is_attributed_to_the_business_party_type(): void {
		$business_post = $this->make_provider( Registrar::BUSINESS );
		$service_id    = $this->make_priced_service( $business_post, 400000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $business_post, '2027-09-05 10:00:00', '2027-09-05 11:00:00' );

		$booking = ( new BookingService() )->create_booking( $customer_id, $business_post, $slot_id, $service_id );
		$result  = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $business_post, 'service_id' => $service_id ]
		);
		wc_get_order( $result['orderId'] )->payment_complete();

		$ledger = new LedgerService();
		$this->assertSame( 0, $ledger->party_receivable_net( LedgerService::PARTY_PROFESSIONAL, $business_post ) );
		$this->assertGreaterThan( 0, $ledger->party_receivable_net( LedgerService::PARTY_BUSINESS, $business_post ) );
	}

	// 3. A Shop (non-booking) order never produces a ledger entry -- confirmed scope exclusion, not an oversight.
	public function test_a_shop_order_produces_no_ledger_entries(): void {
		$product = new \WC_Product_Simple();
		$product->set_name( 'Test Shop Product' );
		$product->set_regular_price( '250000' );
		$product->set_price( '250000' );
		$product->save();

		$order = wc_create_order();
		$order->add_product( $product, 1 );
		$order->calculate_totals();
		$order->save();
		$order->payment_complete();

		$this->assertSame( [], ( new LedgerService() )->for_order( $order->get_id() ) );
	}

	// 4. Cancelling a PAID booking issues a real WooCommerce refund (FIN-02) which the ledger then correctly reverses to zero.
	public function test_cancelling_a_paid_booking_issues_a_real_refund_and_zeroes_the_ledger(): void {
		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 600000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$result          = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$order = wc_get_order( $result['orderId'] );
		$order->payment_complete();
		$booking_service->confirm_booking( $booking['booking_id'] );

		$ledger = new LedgerService();
		$this->assertSame( 510000, $ledger->order_receivable_net( $result['orderId'] ), '85% of 600,000 must be recorded as receivable before cancellation.' );

		$booking_service->cancel_booking( $booking['booking_id'], 'مشتری منصرف شد' );

		$order = wc_get_order( $result['orderId'] ); // Reload -- refund mutates the order.
		$this->assertSame( 'refunded', $order->get_status(), 'A real, full WooCommerce refund must have been issued automatically.' );
		$this->assertEqualsWithDelta( 600000.0, (float) $order->get_total_refunded(), 0.01 );

		$this->assertSame( 0, $ledger->order_receivable_net( $result['orderId'] ), 'The ledger must reflect the cancellation-refund and net back to exactly zero.' );
	}

	// 5. Cancelling a NEVER-PAID (still-pending) booking issues no refund at all -- nothing was ever charged.
	public function test_cancelling_an_unpaid_booking_issues_no_refund(): void {
		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 300000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post, '2027-09-02 10:00:00', '2027-09-02 11:00:00' );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$result          = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		// Deliberately never call payment_complete() -- this booking was never paid.

		$booking_service->cancel_booking( $booking['booking_id'], 'منقضی شد' );

		$order = wc_get_order( $result['orderId'] );
		$this->assertNotSame( 'refunded', $order->get_status() );
		$this->assertSame( [], ( new LedgerService() )->for_order( $result['orderId'] ), 'An order that was never paid must never produce a ledger entry, refund or otherwise.' );
	}

	// 6. A campaign + membership discount stack correctly: commission is computed on the REAL, already-discounted order total -- the ledger never recalculates the discount itself.
	public function test_commission_is_computed_on_the_real_discounted_total_with_campaign_and_membership_stacked(): void {
		$plan = ( new MembershipService() )->create_plan( 'plus-fin', 'پلاس مالی', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف', [ 'percentage' => 10 ] );

		$campaign_id = ( new CampaignService() )->create( [ 'name' => 'کمپین مالی', 'discountType' => CampaignService::TYPE_PERCENTAGE, 'discountValue' => 15 ] )['id'];
		( new CampaignService() )->activate( $campaign_id );

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 1000000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post, '2027-09-06 10:00:00', '2027-09-06 11:00:00' );
		( new MembershipService() )->activate( $customer_id, $plan['id'], 'manual' );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$result  = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$order = wc_get_order( $result['orderId'] );
		// 10% membership + 15% campaign, both independent of each other against the 1,000,000 subtotal -- real order total is 750,000 (Step 17's own "no compounding" design).
		$this->assertEqualsWithDelta( 750000.0, (float) $order->get_total(), 0.01 );

		$order->payment_complete();

		$ledger  = new LedgerService();
		$entries = $ledger->for_order( $result['orderId'] );
		$commission = current( array_filter( $entries, static fn ( $e ) => 'commission' === $e['entryType'] ) );
		$receivable = current( array_filter( $entries, static fn ( $e ) => 'receivable' === $e['entryType'] ) );

		// 15% of the REAL 750,000 total the customer actually paid -- never 15% of the original 1,000,000 subtotal.
		$this->assertSame( 112500, $commission['amount'] );
		$this->assertSame( 637500, $receivable['amount'] );
	}

	// 7. Rescheduling a paid, ledger-recorded booking leaves the ledger entirely untouched -- no duplicate revenue, no duplicate commission.
	public function test_rescheduling_a_paid_booking_does_not_touch_the_ledger(): void {
		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 300000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post, '2027-09-03 10:00:00', '2027-09-03 11:00:00' );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$result          = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		wc_get_order( $result['orderId'] )->payment_complete();
		$booking_service->confirm_booking( $booking['booking_id'] );

		$ledger        = new LedgerService();
		$before_amount = $ledger->order_receivable_net( $result['orderId'] );
		$before_count  = count( $ledger->for_order( $result['orderId'] ) );

		$new_slot_id = $this->make_open_slot( $provider_post, '2027-09-04 10:00:00', '2027-09-04 11:00:00' );
		$reschedule  = ( new \BeauClick\Booking\Booking\RescheduleService() )->reschedule( $booking['booking_id'], $new_slot_id, $customer_id );
		$this->assertIsArray( $reschedule );

		$this->assertSame( $before_amount, $ledger->order_receivable_net( $result['orderId'] ) );
		$this->assertCount( $before_count, $ledger->for_order( $result['orderId'] ) );
	}

	// 8. Idempotency across a spuriously duplicated order (same underlying pattern V2.3 Step 17's own test surfaced: Payments' order-creation handler has no idempotency of its own).
	public function test_a_second_spurious_order_for_the_same_booking_still_records_its_own_correct_entries(): void {
		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 200000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post, '2027-09-07 10:00:00', '2027-09-07 11:00:00' );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$context = [ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ];
		$first   = apply_filters( 'beauclick/booking/after_create', $booking, $context );
		$second  = apply_filters( 'beauclick/booking/after_create', $booking, $context );

		$this->assertNotSame( $first['orderId'], $second['orderId'] );

		wc_get_order( $first['orderId'] )->payment_complete();
		wc_get_order( $second['orderId'] )->payment_complete();

		$ledger = new LedgerService();

		// The first order successfully confirms the (real, shared)
		// booking -- exactly one real commission + receivable pair, net
		// unchanged.
		$this->assertCount( 2, $ledger->for_order( $first['orderId'] ) );
		$this->assertGreaterThan( 0, $ledger->order_receivable_net( $first['orderId'] ) );

		// The second order's payment_complete() also fires MY recorder
		// first (both recorders sit independently on the same
		// woocommerce_payment_complete hook) -- but beauclick-payments'
		// OWN existing pre-Step-18 logic then finds the shared booking
		// already confirmed by the first order and, via its own
		// long-standing handle_paid_but_unconfirmable_booking() path,
		// automatically refunds this second, genuinely-unconfirmable
		// order. That real refund fires woocommerce_order_refunded, which
		// this step's own RefundRecorder correctly reacts to -- so the
		// second order ends up with 4 rows (the original pair plus its own
		// reversal pair), netting to exactly zero. This is the ledger
		// correctly, automatically self-healing a pre-existing Payments
		// edge case it was never specifically designed around -- not a
		// bug, and a stronger correctness guarantee than "each order gets
		// exactly 2 rows" would have been.
		$this->assertCount( 4, $ledger->for_order( $second['orderId'] ) );
		$this->assertSame( 0, $ledger->order_receivable_net( $second['orderId'] ), 'The spurious, auto-refunded second order must never leave a real net receivable behind.' );
	}
}
