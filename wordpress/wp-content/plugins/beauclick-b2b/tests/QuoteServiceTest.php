<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Tests;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Business\QuoteService;
use WP_UnitTestCase;

final class QuoteServiceTest extends WP_UnitTestCase {

	private function make_product( int $price = 100000 ): int {
		$product = new \WC_Product_Simple();
		$product->set_name( 'Test Product' );
		$product->set_regular_price( (string) $price );
		$product->set_price( (string) $price );
		$product->save();
		return $product->get_id();
	}

	private function make_business_account(): array {
		$user_id    = self::factory()->user->create();
		$service    = new BusinessAccountService();
		$account_id = $service->apply( $user_id, 'Test Salon' );
		$service->approve( $account_id );
		return [ $user_id, $account_id ];
	}

	public function test_a_quote_cannot_be_accepted_before_it_is_priced(): void {
		[ $user_id, $account_id ] = $this->make_business_account();
		$product_id = $this->make_product();

		$quotes   = new QuoteService();
		$quote_id = $quotes->request( $account_id, [ [ 'product_id' => $product_id, 'quantity' => 30 ] ] );

		$this->assertNull( $quotes->accept( $quote_id, $user_id ), 'A quote still in "requested" status (not yet priced by an admin) must not be acceptable.' );
	}

	public function test_pricing_then_accepting_creates_a_real_order_with_the_quoted_price(): void {
		[ $user_id, $account_id ] = $this->make_business_account();
		$product_id = $this->make_product( 100000 );

		$quotes   = new QuoteService();
		$quote_id = $quotes->request( $account_id, [ [ 'product_id' => $product_id, 'quantity' => 30 ] ] );

		$quotes->submit_quote_prices( $quote_id, [ [ 'product_id' => $product_id, 'quantity' => 30, 'price' => 82000 ] ] );

		$order = $quotes->accept( $quote_id, $user_id );

		$this->assertNotNull( $order );
		$this->assertSame( 82000.0 * 30, (float) $order->get_total() );
		$this->assertSame( $user_id, $order->get_customer_id() );

		$quote = $quotes->find( $quote_id );
		$this->assertSame( QuoteService::STATUS_ACCEPTED, $quote['status'] );
		$this->assertSame( (string) $order->get_id(), $quote['wc_order_id'] );
	}

	public function test_a_quote_cannot_be_accepted_twice(): void {
		[ $user_id, $account_id ] = $this->make_business_account();
		$product_id = $this->make_product();

		$quotes   = new QuoteService();
		$quote_id = $quotes->request( $account_id, [ [ 'product_id' => $product_id, 'quantity' => 10 ] ] );
		$quotes->submit_quote_prices( $quote_id, [ [ 'product_id' => $product_id, 'quantity' => 10, 'price' => 90000 ] ] );

		$first  = $quotes->accept( $quote_id, $user_id );
		$second = $quotes->accept( $quote_id, $user_id );

		$this->assertNotNull( $first );
		$this->assertNull( $second, 'An already-accepted quote must not be acceptable again (would create a duplicate order).' );
	}

	public function test_an_expired_quote_cannot_be_accepted(): void {
		[ $user_id, $account_id ] = $this->make_business_account();
		$product_id = $this->make_product();

		$quotes   = new QuoteService();
		$quote_id = $quotes->request( $account_id, [ [ 'product_id' => $product_id, 'quantity' => 10 ] ] );
		$quotes->submit_quote_prices( $quote_id, [ [ 'product_id' => $product_id, 'quantity' => 10, 'price' => 90000 ] ], gmdate( 'Y-m-d H:i:s', time() - HOUR_IN_SECONDS ) );

		$this->assertNull( $quotes->accept( $quote_id, $user_id ) );
	}
}
