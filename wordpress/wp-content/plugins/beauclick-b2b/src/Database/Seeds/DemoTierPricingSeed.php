<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Database\Seeds;

use BeauClick\B2B\Pricing\TierPricingEngine;

/**
 * Wholesale tiers for the demo Shop products, matching the design
 * handoff's B2B tier table exactly: ۱-۹ / ۱۰-۴۹ / ۵۰-۹۹ (پیشنهادی) / ۱۰۰+.
 * Idempotent via TierPricingEngine::set_tiers() (delete + reinsert), safe
 * to run repeatedly.
 */
final class DemoTierPricingSeed {

	public static function run(): void {
		global $wpdb;
		$engine = new TierPricingEngine();

		$products = $wpdb->get_results( "SELECT ID, post_title FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish'" );

		foreach ( $products as $product ) {
			$product_id    = (int) $product->ID; // $wpdb always returns numeric columns as strings.
			$regular_price = (int) get_post_meta( $product_id, '_regular_price', true );
			if ( ! $regular_price ) {
				continue;
			}

			$engine->set_tiers(
				$product_id,
				[
					[ 'min_qty' => 1, 'max_qty' => 9, 'price' => $regular_price ],
					[ 'min_qty' => 10, 'max_qty' => 49, 'price' => (int) round( $regular_price * 0.9 ) ],
					[ 'min_qty' => 50, 'max_qty' => 99, 'price' => (int) round( $regular_price * 0.8 ), 'is_recommended' => true ],
					[ 'min_qty' => 100, 'max_qty' => null, 'price' => (int) round( $regular_price * 0.7 ) ],
				]
			);
		}
	}
}
