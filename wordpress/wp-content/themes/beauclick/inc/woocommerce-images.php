<?php
/**
 * Extends the existing bc_mockup_image_url() fallback (real image wins,
 * else a themed SVG mockup, else the gradient .bc-placeholder-image
 * treatment — already used by template-parts/product-card.php and
 * single-bc_professional.php) to WooCommerce's own single-product
 * gallery, which otherwise falls back to WooCommerce's own default gray
 * placeholder.png — the one surface in the shop that didn't honor this
 * product's already-established "no photo yet" convention.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

add_filter( 'woocommerce_single_product_image_thumbnail_html', 'beauclick_product_gallery_placeholder', 10, 2 );

function beauclick_product_gallery_placeholder( string $html, $post_thumbnail_id ): string {
	if ( $post_thumbnail_id ) {
		return $html;
	}

	global $product;
	if ( ! $product instanceof WC_Product ) {
		return $html;
	}

	$mockup_url = bc_mockup_image_url( $product->get_id() );
	if ( $mockup_url ) {
		return sprintf(
			'<div class="woocommerce-product-gallery__image--placeholder"><img src="%s" alt="%s" class="wp-post-image" /></div>',
			esc_url( $mockup_url ),
			esc_attr( $product->get_name() )
		);
	}

	return sprintf(
		'<div class="woocommerce-product-gallery__image--placeholder bc-placeholder-image" style="aspect-ratio:4/3;background:linear-gradient(135deg, oklch(0.9 0.04 335), oklch(0.82 0.06 300));"><span>%s</span></div>',
		esc_html__( 'تصویر محصول', 'beauclick' )
	);
}

/**
 * Same fallback, for every other surface that renders a product image via
 * WC_Product::get_image() — cart, mini-cart, checkout order review — found
 * live still showing WooCommerce's own default gray woocommerce-placeholder.png
 * for a product whose single-product page already correctly shows its
 * mockup (they're two separate WooCommerce code paths).
 */
add_filter( 'woocommerce_product_get_image', 'beauclick_product_list_image_placeholder', 10, 2 );

function beauclick_product_list_image_placeholder( string $image, $product ): string {
	if ( ! $product instanceof WC_Product || $product->get_image_id() ) {
		return $image;
	}

	$mockup_url = bc_mockup_image_url( $product->get_id() );
	if ( $mockup_url ) {
		return sprintf(
			'<img src="%s" alt="%s" class="wp-post-image" width="80" height="80" style="object-fit:cover;border-radius:var(--bc-radius-row, 14px);" />',
			esc_url( $mockup_url ),
			esc_attr( $product->get_name() )
		);
	}

	return '<div class="bc-placeholder-image" style="width:80px;height:80px;border-radius:var(--bc-radius-row, 14px);background:linear-gradient(135deg, oklch(0.9 0.04 335), oklch(0.82 0.06 300));"></div>';
}
