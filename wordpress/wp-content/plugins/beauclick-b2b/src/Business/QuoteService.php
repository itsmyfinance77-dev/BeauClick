<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Business;

/**
 * Quote acceptance produces a real WooCommerce order (architecture doc §13
 * — "reuse checkout/payment machinery rather than a parallel invoicing
 * system"), the same "domain entity becomes a WC_Order" pattern
 * beauclick-payments already uses for bookings.
 */
final class QuoteService {

	public const STATUS_REQUESTED = 'requested';
	public const STATUS_QUOTED    = 'quoted';
	public const STATUS_ACCEPTED  = 'accepted';
	public const STATUS_EXPIRED   = 'expired';

	/** @param list<array{product_id:int, quantity:int}> $items */
	public function request( int $business_account_id, array $items ): int {
		global $wpdb;
		$now = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_quotes',
			[
				'business_account_id' => $business_account_id,
				'status'               => self::STATUS_REQUESTED,
				'items'                => wp_json_encode( array_values( $items ) ),
				'created_at'           => $now,
				'updated_at'           => $now,
			]
		);

		$id = $wpdb->insert_id;
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'b2b_quote_requested', 'quote', $id, null, [ 'business_account_id' => $business_account_id ] );
		}

		return $id;
	}

	/**
	 * Admin prices each line item and the quote becomes acceptable.
	 *
	 * @param list<array{product_id:int, quantity:int, price:int}> $priced_items
	 */
	public function submit_quote_prices( int $quote_id, array $priced_items, ?string $expires_at = null ): bool {
		global $wpdb;
		$quote = $this->find( $quote_id );
		if ( ! $quote || self::STATUS_REQUESTED !== $quote['status'] ) {
			return false;
		}

		$total = array_reduce( $priced_items, static fn ( int $sum, array $i ) => $sum + ( $i['price'] * $i['quantity'] ), 0 );

		$wpdb->update(
			$wpdb->prefix . 'bc_quotes',
			[
				'status'       => self::STATUS_QUOTED,
				'items'        => wp_json_encode( $priced_items ),
				'quoted_total' => $total,
				'expires_at'   => $expires_at,
				'updated_at'   => current_time( 'mysql' ),
			],
			[ 'id' => $quote_id ]
		);

		return true;
	}

	/**
	 * Converts an accepted quote into a real WooCommerce order — the buyer
	 * then pays through the normal checkout flow, same as any other order.
	 */
	public function accept( int $quote_id, int $customer_user_id ): ?\WC_Order {
		$quote = $this->find( $quote_id );
		if ( ! $quote || self::STATUS_QUOTED !== $quote['status'] ) {
			return null;
		}

		if ( $quote['expires_at'] && strtotime( $quote['expires_at'] ) < time() ) {
			$this->mark_expired( $quote_id );
			return null;
		}

		$items = json_decode( $quote['items'], true ) ?: [];
		if ( ! $items ) {
			return null;
		}

		$order = wc_create_order( [ 'customer_id' => $customer_user_id ] );
		foreach ( $items as $item ) {
			$product = wc_get_product( $item['product_id'] );
			if ( ! $product ) {
				continue;
			}
			$order_item = new \WC_Order_Item_Product();
			$order_item->set_product( $product );
			$order_item->set_quantity( $item['quantity'] );
			$order_item->set_subtotal( (string) ( $item['price'] * $item['quantity'] ) );
			$order_item->set_total( (string) ( $item['price'] * $item['quantity'] ) );
			$order->add_item( $order_item );
		}

		$order->update_meta_data( '_bc_quote_id', $quote_id );
		$order->calculate_totals();
		$order->set_status( 'pending' );
		$order->save();

		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_quotes',
			[ 'status' => self::STATUS_ACCEPTED, 'wc_order_id' => $order->get_id(), 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $quote_id ]
		);

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'b2b_quote_accepted', 'quote', $quote_id, $customer_user_id, [ 'order_id' => $order->get_id() ] );
		}

		return $order;
	}

	private function mark_expired( int $quote_id ): void {
		global $wpdb;
		$wpdb->update( $wpdb->prefix . 'bc_quotes', [ 'status' => self::STATUS_EXPIRED, 'updated_at' => current_time( 'mysql' ) ], [ 'id' => $quote_id ] );
	}

	public function find( int $quote_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_quotes WHERE id = %d", $quote_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	/** @return list<array<string,mixed>> */
	public function for_business_account( int $business_account_id ): array {
		global $wpdb;
		return $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_quotes WHERE business_account_id = %d ORDER BY created_at DESC", $business_account_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		) ?: [];
	}
}
