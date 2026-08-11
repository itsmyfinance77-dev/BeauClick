<?php
/**
 * Renders one WooCommerce product using the BeauClick design system.
 * Expects $args['product'] (WC_Product).
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

/** @var \WC_Product|null $product */
$product = $args['product'] ?? null;
if ( ! $product ) {
	return;
}

$on_sale   = $product->is_on_sale();
$regular   = (int) $product->get_regular_price();
$price     = (int) $product->get_price();
$brand_terms = wp_get_post_terms( $product->get_id(), 'product_brand', [ 'fields' => 'names' ] );
?>
<div class="bc-card bc-card--hoverable">
	<a href="<?php echo esc_url( get_permalink( $product->get_id() ) ); ?>" style="display:block; position:relative;">
		<?php if ( $on_sale ) : ?>
			<span class="bc-badge bc-badge--discount" style="position:absolute; inset-block-start:10px; inset-inline-start:10px; z-index:1;">
				<?php echo esc_html( bc_persian_digits( round( ( 1 - $price / max( $regular, 1 ) ) * 100 ) ) ); ?>٪
			</span>
		<?php endif; ?>
		<div class="bc-placeholder-image" style="aspect-ratio:4/3;background:linear-gradient(135deg, oklch(0.9 0.04 335), oklch(0.82 0.06 300));">
			<span><?php esc_html_e( 'تصویر محصول', 'beauclick' ); ?></span>
		</div>
	</a>
	<div class="bc-provider-card__body">
		<?php if ( ! empty( $brand_terms ) && ! is_wp_error( $brand_terms ) ) : ?>
			<p class="bc-provider-card__meta" style="margin:0 0 4px;"><?php echo esc_html( $brand_terms[0] ); ?></p>
		<?php endif; ?>
		<a href="<?php echo esc_url( get_permalink( $product->get_id() ) ); ?>" style="color:inherit;">
			<strong><?php echo esc_html( $product->get_name() ); ?></strong>
		</a>
		<div style="margin:10px 0;">
			<span class="bc-price bc-numeric">
				<span class="bc-price__amount"><?php echo esc_html( bc_format_toman( $price ) ); ?></span>
				<span class="bc-price__unit"><?php esc_html_e( 'تومان', 'beauclick' ); ?></span>
				<?php if ( $on_sale ) : ?>
					<span class="bc-price__old"><?php echo esc_html( bc_format_toman( $regular ) ); ?></span>
				<?php endif; ?>
			</span>
		</div>
		<button type="button" class="bc-btn bc-btn--outline" style="width:100%;" data-bc-add-to-cart data-product-id="<?php echo esc_attr( $product->get_id() ); ?>">
			<?php esc_html_e( 'افزودن به سبد', 'beauclick' ); ?>
		</button>
	</div>
</div>
