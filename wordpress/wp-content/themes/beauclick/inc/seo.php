<?php
/**
 * Meta description + Open Graph tags — a production-readiness audit found
 * neither existed anywhere in the theme. WordPress core's own wp_head()
 * only adds a canonical URL (on singular views) and a generator tag by
 * default; it does NOT add a meta description or OG tags without an SEO
 * plugin, which this project doesn't use. WooCommerce already outputs
 * real Product/BreadcrumbList JSON-LD on its own template pages (verified
 * live), so that's intentionally not duplicated here.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'wp_head', 'bc_render_seo_meta', 1 );

function bc_render_seo_meta(): void {
	[ $title, $description ] = bc_seo_title_and_description();
	$description             = wp_trim_words( wp_strip_all_tags( $description ), 30, '…' );
	$image                   = bc_seo_image_url();

	echo '<meta name="description" content="' . esc_attr( $description ) . '">' . "\n";
	echo '<meta property="og:site_name" content="BeauClick">' . "\n";
	echo '<meta property="og:locale" content="fa_IR">' . "\n";
	echo '<meta property="og:type" content="' . ( is_singular() ? 'article' : 'website' ) . '">' . "\n";
	echo '<meta property="og:title" content="' . esc_attr( $title ) . '">' . "\n";
	echo '<meta property="og:description" content="' . esc_attr( $description ) . '">' . "\n";
	echo '<meta property="og:url" content="' . esc_url( bc_current_url() ) . '">' . "\n";
	if ( $image ) {
		echo '<meta property="og:image" content="' . esc_url( $image ) . '">' . "\n";
	}
	echo '<meta name="twitter:card" content="summary_large_image">' . "\n";
}

/** @return array{0: string, 1: string} */
function bc_seo_title_and_description(): array {
	if ( is_singular( [ 'bc_professional', 'bc_business' ] ) ) {
		$provider_id = get_the_ID();
		$index_row   = bc_get_provider_index_row( $provider_id );
		$city_name   = $index_row && ! empty( $index_row['city_id'] ) ? bc_get_city_name( (int) $index_row['city_id'] ) : '';
		$specialties = wp_get_post_terms( $provider_id, 'bc_specialty', [ 'fields' => 'names' ] );
		$context     = trim( implode( ' · ', array_filter( [ implode( '، ', (array) $specialties ), $city_name ] ) ) );
		$bio         = get_the_content( null, false, $provider_id );

		return [
			get_the_title() . ' | BeauClick',
			$context && $bio ? "{$context} — {$bio}" : ( $bio ?: $context ?: get_the_title() ),
		];
	}

	if ( is_singular( 'product' ) ) {
		global $product;
		$wc_product = $product instanceof \WC_Product ? $product : wc_get_product( get_the_ID() );
		$excerpt    = $wc_product ? $wc_product->get_short_description() : '';

		return [
			get_the_title() . ' | فروشگاه BeauClick',
			$excerpt ?: get_the_content(),
		];
	}

	if ( is_front_page() ) {
		return [
			'BeauClick — مارکت‌پلیس هوشمند زیبایی',
			'جست‌وجو، مقایسه و رزرو آنلاین بهترین متخصصان و مراکز زیبایی در سراسر ایران — به‌همراه فروشگاه محصولات و دستیار هوشمند زیبایی.',
		];
	}

	if ( is_page( 'marketplace' ) ) {
		return [
			'متخصصان زیبایی | BeauClick',
			'متخصصان و سالن‌های زیبایی تایید‌شده را در سراسر ایران پیدا کن و آنلاین نوبت بگیر.',
		];
	}

	if ( is_page( 'b2b' ) ) {
		return [
			'BeauClick Business — خرید عمده',
			'خرید عمده محصولات آرایشی و بهداشتی برای سالن‌ها و کلینیک‌ها با تخفیف پلکانی.',
		];
	}

	if ( is_singular() ) {
		return [ get_the_title() . ' | BeauClick', get_the_excerpt() ?: get_the_title() ];
	}

	return [ get_bloginfo( 'name' ), get_bloginfo( 'description' ) ?: 'BeauClick — مارکت‌پلیس هوشمند زیبایی' ];
}

function bc_seo_image_url(): ?string {
	if ( is_singular( 'product' ) && has_post_thumbnail() ) {
		return get_the_post_thumbnail_url( get_the_ID(), 'large' ) ?: null;
	}
	return defined( 'BEAUCLICK_THEME_URI' ) ? BEAUCLICK_THEME_URI . '/assets/brand/icon-gradient.svg' : null;
}

function bc_current_url(): string {
	global $wp;
	return home_url( add_query_arg( [], $wp->request ?? '' ) );
}
