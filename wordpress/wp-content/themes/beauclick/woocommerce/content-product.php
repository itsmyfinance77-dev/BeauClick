<?php
/**
 * Product loop card — governs the related-products loop, the up-sells
 * loop, and any [products]/[related_products] shortcode output, all of
 * which call this same partial by the WooCommerce template hierarchy
 * (the shop grid itself, woocommerce/archive-product.php, bypasses this
 * file entirely and already renders template-parts/product-card.php
 * directly). Reuses that exact card markup so a product looks identical
 * everywhere it appears, instead of falling back to WooCommerce's own
 * unstyled <li> markup.
 *
 * This template can be overridden by copying it to yourtheme/woocommerce/content-product.php.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

global $product;

if ( ! $product instanceof WC_Product || ! $product->is_visible() ) {
	return;
}
?>
<li <?php wc_product_class( '', $product ); ?>>
	<?php get_template_part( 'template-parts/product-card', null, array( 'product' => $product ) ); ?>
</li>
