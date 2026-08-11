<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Pricing;

use BeauClick\B2B\Business\BusinessAccountService;

/**
 * Quantity-break wholesale pricing, applied directly through WooCommerce's
 * own cart-price hook rather than a parallel pricing system — a tiered
 * product still goes through the real cart/checkout/order/coupon/tax
 * pipeline, just with a different unit price once quantity crosses a
 * threshold. A product's MOQ is the minimum quantity of its lowest tier —
 * there's no separate MOQ concept to keep in sync with the tier table.
 */
final class TierPricingEngine {

	public function register(): void {
		add_filter( 'woocommerce_add_to_cart_validation', [ $this, 'validate_moq' ], 10, 3 );
		add_action( 'woocommerce_before_calculate_totals', [ $this, 'apply_tier_prices' ], 20 );
	}

	/** @return list<array{id:int, min_qty:int, max_qty:?int, price:int, isRecommended:bool}> Ordered by min_qty ascending. */
	public function get_tiers( int $product_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_b2b_price_tiers WHERE product_id = %d ORDER BY min_qty ASC", $product_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		return array_map(
			static fn ( array $r ) => [
				'id'            => (int) $r['id'],
				'min_qty'       => (int) $r['min_qty'],
				'max_qty'       => null !== $r['max_qty'] ? (int) $r['max_qty'] : null,
				'price'         => (int) $r['price'],
				'isRecommended' => (bool) $r['is_recommended'],
			],
			$rows ?: []
		);
	}

	/** @param list<array{min_qty:int, max_qty?:?int, price:int, is_recommended?:bool}> $tiers */
	public function set_tiers( int $product_id, array $tiers ): void {
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'bc_b2b_price_tiers', [ 'product_id' => $product_id ] );

		foreach ( $tiers as $tier ) {
			$wpdb->insert(
				$wpdb->prefix . 'bc_b2b_price_tiers',
				[
					'product_id'     => $product_id,
					'min_qty'        => $tier['min_qty'],
					'max_qty'        => $tier['max_qty'] ?? null,
					'price'          => $tier['price'],
					'is_recommended' => ! empty( $tier['is_recommended'] ) ? 1 : 0,
				]
			);
		}
	}

	public function has_tiers( int $product_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$wpdb->prefix}bc_b2b_price_tiers WHERE product_id = %d LIMIT 1", $product_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	public function moq( int $product_id ): ?int {
		$tiers = $this->get_tiers( $product_id );
		return $tiers[0]['min_qty'] ?? null;
	}

	public function price_for_quantity( int $product_id, int $quantity ): ?int {
		foreach ( $this->get_tiers( $product_id ) as $tier ) {
			$within_max = null === $tier['max_qty'] || $quantity <= $tier['max_qty'];
			if ( $quantity >= $tier['min_qty'] && $within_max ) {
				return $tier['price'];
			}
		}
		return null; // Below MOQ, or above every defined tier's max with no open-ended top tier.
	}

	public function validate_moq( bool $passed, int $product_id, int $quantity ): bool {
		if ( ! $this->should_apply_tier_pricing( $product_id ) ) {
			return $passed;
		}

		$moq = $this->moq( $product_id );
		if ( $moq && $quantity < $moq ) {
			wc_add_notice(
				sprintf(
					/* translators: %d: minimum order quantity */
					__( 'حداقل سفارش این محصول برای خرید عمده %d عدد است.', 'beauclick-b2b' ),
					$moq
				),
				'error'
			);
			return false;
		}

		return $passed;
	}

	public function apply_tier_prices( \WC_Cart $cart ): void {
		if ( is_admin() && ! wp_doing_ajax() ) {
			return;
		}

		foreach ( $cart->get_cart() as $cart_item ) {
			$product_id = $cart_item['product_id'];
			if ( ! $this->should_apply_tier_pricing( $product_id ) ) {
				continue;
			}

			$price = $this->price_for_quantity( $product_id, (int) $cart_item['quantity'] );
			if ( null !== $price ) {
				$cart_item['data']->set_price( (string) $price );
			}
		}
	}

	private function should_apply_tier_pricing( int $product_id ): bool {
		if ( ! $this->has_tiers( $product_id ) ) {
			return false;
		}
		return ( new BusinessAccountService() )->is_approved( get_current_user_id() );
	}
}
