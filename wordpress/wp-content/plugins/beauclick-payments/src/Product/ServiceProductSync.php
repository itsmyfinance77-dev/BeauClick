<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Product;

/**
 * Keeps a real, hidden WooCommerce virtual product in sync with each
 * bc_service post. This replaces an earlier ad-hoc-fee-line design after
 * architectural review: a fee line has no product identity to hang tax
 * classes, coupon rules, B2B tier pricing (Phase 7), or WooCommerce's own
 * product-based sales reporting off of — all of that machinery expects a
 * real WC_Product. bc_service stays the actual source of truth for name,
 * duration, and description; this sync only mirrors what WooCommerce
 * itself needs (title, price) into a linked product, the way a booking
 * plugin conventionally bridges "bookable thing" to "purchasable thing".
 *
 * The synced product is `catalog_visibility = hidden` — it must never
 * appear in Shop search/browse (a service is booked through the
 * marketplace/profile flow, not bought like a retail product) but still
 * works perfectly as a normal order line item, coupon target, and report
 * row, because it IS a normal product underneath.
 */
final class ServiceProductSync {

	private const META_LINKED_PRODUCT = '_bc_linked_product_id';
	private const META_SOURCE_SERVICE = '_bc_service_id';

	public function register(): void {
		add_action( 'save_post_bc_service', [ $this, 'sync_from_post' ], 20, 2 );
		add_action( 'before_delete_post', [ $this, 'maybe_unlink' ] );
	}

	public function sync_from_post( int $service_id, \WP_Post $post ): void {
		if ( wp_is_post_revision( $service_id ) || wp_is_post_autosave( $service_id ) ) {
			return;
		}
		$this->sync( $service_id );
	}

	/**
	 * Idempotent: safe to call even if a product is already linked and
	 * current — get_or_create() reuses the existing one rather than ever
	 * creating a duplicate.
	 */
	public function sync( int $service_id ): \WC_Product {
		$post  = get_post( $service_id );
		$price = (string) ( (int) get_post_meta( $service_id, '_bc_price', true ) );

		$product = $this->get_or_create( $service_id );
		$product->set_name( $post->post_title );
		$product->set_regular_price( $price );
		$product->set_price( $price );
		$product->set_virtual( true );
		$product->set_catalog_visibility( 'hidden' );
		$product->set_status( 'publish' === $post->post_status ? 'publish' : 'draft' );
		$product->update_meta_data( self::META_SOURCE_SERVICE, $service_id );
		$product->save();

		update_post_meta( $service_id, self::META_LINKED_PRODUCT, $product->get_id() );

		return $product;
	}

	private function get_or_create( int $service_id ): \WC_Product {
		$existing_id = (int) get_post_meta( $service_id, self::META_LINKED_PRODUCT, true );

		if ( $existing_id ) {
			$existing = wc_get_product( $existing_id );
			if ( $existing ) {
				return $existing;
			}
		}

		return new \WC_Product_Simple();
	}

	public function maybe_unlink( int $post_id ): void {
		$post = get_post( $post_id );
		if ( ! $post || 'bc_service' !== $post->post_type ) {
			return;
		}
		$product_id = (int) get_post_meta( $post_id, self::META_LINKED_PRODUCT, true );
		if ( $product_id ) {
			wp_trash_post( $product_id );
		}
	}
}
