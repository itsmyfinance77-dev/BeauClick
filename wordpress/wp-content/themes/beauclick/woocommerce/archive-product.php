<?php
/**
 * Shop archive — overrides WooCommerce's default product grid entirely
 * with the BeauClick design system, matching the same chip-filter + grid
 * pattern as page-marketplace.php (design handoff §5). This is a full
 * page template (not a content fragment) since archive-product.php is
 * itself top-level in the WordPress template hierarchy — it calls
 * get_header()/get_footer() the same way front-page.php does.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

get_header();

$category_id = isset( $_GET['product_cat_id'] ) ? absint( $_GET['product_cat_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

$query_args = [
	'status'   => 'publish',
	'limit'    => 48,
	'orderby'  => 'date',
	'order'    => 'DESC',
	// wc_get_products() does NOT automatically respect WooCommerce's
	// catalog-visibility taxonomy the way the native shop archive query
	// does — without this, a service's hidden, booking-only synced
	// product (Payments\Product\ServiceProductSync — catalog_visibility
	// set to 'hidden' specifically so it never appears here) shows up in
	// the Shop grid anyway. Excluding both visibility-hiding terms
	// directly is the same filtering the native query applies for free.
	'tax_query' => [ // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
		[
			'taxonomy' => 'product_visibility',
			'field'    => 'slug',
			'terms'    => [ 'exclude-from-catalog' ],
			'operator' => 'NOT IN',
		],
	],
];
if ( $category_id ) {
	$query_args['category'] = [ get_term( $category_id )->slug ?? '' ];
}

$products    = wc_get_products( $query_args );
$categories  = get_terms( [ 'taxonomy' => 'product_cat', 'hide_empty' => true ] );
$categories  = is_wp_error( $categories ) ? [] : $categories;
?>

<div class="bc-container bc-section">
	<h1 class="bc-section__title"><?php esc_html_e( 'فروشگاه محصولات زیبایی', 'beauclick' ); ?></h1>

	<?php if ( $categories ) : ?>
		<div class="bc-chip-row">
			<a href="<?php echo esc_url( remove_query_arg( 'product_cat_id' ) ); ?>" class="bc-chip bc-chip--primary <?php echo ! $category_id ? 'bc-chip--active' : ''; ?>"><?php esc_html_e( 'همه دسته‌ها', 'beauclick' ); ?></a>
			<?php foreach ( $categories as $cat ) : ?>
				<?php if ( 'uncategorized' === $cat->slug ) continue; ?>
				<a href="<?php echo esc_url( add_query_arg( 'product_cat_id', $cat->term_id ) ); ?>" class="bc-chip bc-chip--primary <?php echo ( (int) $category_id === (int) $cat->term_id ) ? 'bc-chip--active' : ''; ?>"><?php echo esc_html( $cat->name ); ?></a>
			<?php endforeach; ?>
		</div>
	<?php endif; ?>

	<?php if ( $products ) : ?>
		<div class="bc-grid">
			<?php foreach ( $products as $product ) : ?>
				<?php get_template_part( 'template-parts/product-card', null, [ 'product' => $product ] ); ?>
			<?php endforeach; ?>
		</div>
	<?php else : ?>
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'محصولی یافت نشد.', 'beauclick' ); ?></p>
		</div>
	<?php endif; ?>
</div>

<?php
get_footer();
