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
 * V2.2 Step 12 extends this file with: canonical URLs for every page type
 * (not just WP core's singular-only default), city/specialty-aware
 * marketplace metadata (a real gap — the marketplace title/description used
 * to be static regardless of which city/specialty was being viewed), real
 * structured data (LocalBusiness/Service/BreadcrumbList/WebSite JSON-LD —
 * professional/business profiles and the homepage had none before this
 * step), and explicit indexability control (noindex for account-only pages,
 * canonical-collapse for zero-result/thin marketplace filter combinations).
 *
 * Deliberately did NOT introduce new pretty URLs for city/specialty pages,
 * even though this environment does run a real "post name" permalink
 * structure with working rewrite rules (verified directly — a naive
 * earlier reading of bc_provider_permalink()'s own docblock suggested
 * otherwise; that comment describes a hand-built path's failure mode under
 * Plain permalinks in general, not this environment's actual current
 * setting, and is corrected here rather than left to mislead the next
 * reader). Adding new `add_rewrite_rule()` entries for city/specialty
 * paths was still deliberately avoided for this step: it would need a
 * flush timed to plugin/theme activation (a real, easy-to-get-wrong
 * moving part — a missed flush silently 404s every new URL), and this
 * task's own instruction is explicit about not "casually" changing URL
 * structure. The existing `?city_id=`/`?specialty_id=` query-string
 * marketplace filtering stays exactly as it is — this file only adds the
 * metadata/canonical/structured-data/sitemap layer on top of it (a
 * well-established, Google-supported pattern for faceted navigation when
 * each parameter combination represents genuinely distinct content and is
 * handled with correct canonical/sitemap treatment, which is exactly what
 * this step does — see inc/sitemap.php). If pretty city/specialty URLs are
 * ever wanted, this metadata/canonical/structured-data logic carries over
 * directly — only the URL-building and rewrite registration would need to
 * change, not the SEO logic itself.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// WP core's own wp_head adds a second, plain canonical on every singular
// view (rel_canonical(), default priority 10) — bc_render_seo_meta() below
// already emits one, correctly, for every page type this theme has,
// singular or not. Removing core's prevents two <link rel="canonical">
// tags from appearing on the same page, a real duplicate found and fixed
// during this step's own live verification.
remove_action( 'wp_head', 'rel_canonical' );

add_action( 'wp_head', 'bc_render_seo_meta', 1 );
add_action( 'wp_head', 'bc_render_structured_data', 2 );
add_filter( 'wp_robots', 'bc_filter_wp_robots' );

/**
 * The REAL <title> tag -- what actually appears as the clickable headline
 * in a Google search result, found completely static during this step's
 * own live verification (a real bug: bc_seo_title_and_description()'s
 * dynamic, city/specialty-aware title was already correctly feeding
 * og:title/meta description, but nothing ever fed it to the page's own
 * <title> element, which add_theme_support('title-tag') generates from
 * WP core's own document_title_parts filter instead). Our own $title
 * already includes "BeauClick" consistently in every branch (a suffix
 * "| BeauClick" or a "BeauClick —" prefix), so the site name part is
 * cleared here to avoid WP core doubling it via its own %title% %sep%
 * %sitename% format.
 */
add_filter( 'document_title_parts', 'bc_filter_document_title_parts' );

function bc_filter_document_title_parts( array $parts ): array {
	[ $title ] = bc_seo_title_and_description();
	$parts['title'] = $title;
	unset( $parts['site'], $parts['tagline'] );
	return $parts;
}

function bc_render_seo_meta(): void {
	[ $title, $description ] = bc_seo_title_and_description();
	$description             = wp_trim_words( wp_strip_all_tags( $description ), 30, '…' );
	$image                   = bc_seo_image_url();
	$canonical                = bc_seo_canonical_url();

	echo '<meta name="description" content="' . esc_attr( $description ) . '">' . "\n";
	if ( $canonical ) {
		echo '<link rel="canonical" href="' . esc_url( $canonical ) . '">' . "\n";
	}
	echo '<meta property="og:site_name" content="BeauClick">' . "\n";
	echo '<meta property="og:locale" content="fa_IR">' . "\n";
	echo '<meta property="og:type" content="' . ( is_singular() ? 'article' : 'website' ) . '">' . "\n";
	echo '<meta property="og:title" content="' . esc_attr( $title ) . '">' . "\n";
	echo '<meta property="og:description" content="' . esc_attr( $description ) . '">' . "\n";
	echo '<meta property="og:url" content="' . esc_url( $canonical ?: bc_current_url() ) . '">' . "\n";
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

	// V2.2 Step 12: was previously a static title/description regardless of
	// which city/specialty was actually being viewed — the single biggest
	// named SEO gap ("میکاپ عروس در یزد" — the architecture proposal's own
	// flagship example query — could never rank when every /marketplace/
	// variant shared identical metadata). Now genuinely reflects the real
	// filtered result set, matching bc_get_meaningful_marketplace_filters().
	if ( is_page( 'marketplace' ) ) {
		[ $city_id, $specialty_id ] = bc_get_meaningful_marketplace_filters();
		$city_name     = $city_id ? bc_get_city_name( $city_id ) : '';
		$specialty_name = $specialty_id ? bc_get_specialty_name( $specialty_id ) : '';

		if ( $specialty_name && $city_name ) {
			return [
				sprintf( '%1$s در %2$s | BeauClick', $specialty_name, $city_name ),
				sprintf( 'بهترین متخصصان %1$s در %2$s را روی BeauClick پیدا کن و آنلاین نوبت بگیر — پروفایل‌های تایید‌شده، امتیاز واقعی مشتریان و رزرو آسان.', $specialty_name, $city_name ),
			];
		}
		if ( $specialty_name ) {
			return [
				sprintf( '%1$s | BeauClick', $specialty_name ),
				sprintf( 'متخصصان %1$s تایید‌شده را در سراسر ایران روی BeauClick پیدا کن و آنلاین نوبت بگیر.', $specialty_name ),
			];
		}
		if ( $city_name ) {
			return [
				sprintf( 'متخصصان زیبایی در %1$s | BeauClick', $city_name ),
				sprintf( 'متخصصان و سالن‌های زیبایی تایید‌شده در %1$s را پیدا کن و آنلاین نوبت بگیر.', $city_name ),
			];
		}

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

/**
 * Reads city_id/specialty_id from the request and resolves them only if
 * they refer to REAL rows with real content — an unrecognized id, an
 * unlaunched city, or a combination with zero matching providers all
 * return [0, 0] (treated as "no meaningful filter"), so a nonsense/thin
 * query-string variant never gets its own canonical/title/structured-data
 * identity. Shared by the SEO meta, canonical, robots, and sitemap logic
 * in this file so all four always agree on what counts as "real."
 *
 * @return array{0:int,1:int}
 */
function bc_get_meaningful_marketplace_filters(): array {
	if ( ! is_page( 'marketplace' ) ) {
		return [ 0, 0 ];
	}

	$city_id      = isset( $_GET['city_id'] ) ? absint( $_GET['city_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	$specialty_id = isset( $_GET['specialty_id'] ) ? absint( $_GET['specialty_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

	if ( $city_id && ! bc_is_launched_city( $city_id ) ) {
		$city_id = 0;
	}
	if ( $specialty_id && ! term_exists( $specialty_id, 'bc_specialty' ) ) {
		$specialty_id = 0;
	}
	if ( ( $city_id || $specialty_id ) && bc_marketplace_result_count( $city_id, $specialty_id ) < 1 ) {
		// A real city/specialty but zero matching providers today -- not
		// worth its own indexed identity (§11/§12's own "avoid thin pages"
		// instruction). The page still renders normally for a human visitor
		// (the existing empty-state UI), just without a distinct
		// title/canonical/structured-data footprint search engines should
		// treat as real content.
		return [ 0, 0 ];
	}

	return [ $city_id, $specialty_id ];
}

function bc_is_launched_city( int $city_id ): bool {
	global $wpdb;
	static $cache = [];
	if ( ! isset( $cache[ $city_id ] ) ) {
		$cache[ $city_id ] = (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$wpdb->prefix}bc_cities WHERE id = %d AND is_launched = 1", $city_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}
	return $cache[ $city_id ];
}

function bc_get_specialty_name( int $specialty_id ): string {
	$term = get_term( $specialty_id, 'bc_specialty' );
	return ( $term && ! is_wp_error( $term ) ) ? $term->name : '';
}

function bc_marketplace_result_count( int $city_id, int $specialty_id ): int {
	global $wpdb;
	$where  = [ '1=1' ];
	$params = [];
	if ( $city_id ) {
		$where[]  = 'city_id = %d';
		$params[] = $city_id;
	}
	if ( $specialty_id ) {
		$where[]  = 'FIND_IN_SET(%d, specialty_ids)';
		$params[] = $specialty_id;
	}
	$sql = "SELECT COUNT(*) FROM {$wpdb->prefix}bc_provider_index WHERE " . implode( ' AND ', $where ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	return (int) $wpdb->get_var( $params ? $wpdb->prepare( $sql, $params ) : $sql ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
}

/**
 * Explicit canonical for every page type WP core doesn't already handle
 * (core only adds one on singular views). For the marketplace, a
 * meaningful city/specialty combination gets a self-referencing canonical
 * (it's real, distinct, valuable content — see the docblock at the top of
 * this file for why that's a pretty-URL-free query-string canonical, not a
 * new path); anything else (an unrecognized id, a thin/zero-result combo,
 * pagination-style params) canonicalizes UP to the plain /marketplace/ root
 * — never down to the homepage, and never left ambiguous.
 */
function bc_seo_canonical_url(): ?string {
	// is_page('marketplace') checked BEFORE the generic is_singular() below
	// -- a WP Page satisfies is_singular() too, which silently shadowed this
	// entire branch and always fell through to a plain get_permalink() with
	// no query string, discarding a real city/specialty combination's own
	// canonical. A real bug caught during this step's own live verification
	// (the marketplace title/description/structured-data logic elsewhere in
	// this file all correctly used bc_get_meaningful_marketplace_filters();
	// only this function had the wrong branch order).
	if ( is_page( 'marketplace' ) ) {
		[ $city_id, $specialty_id ] = bc_get_meaningful_marketplace_filters();
		$base = home_url( '/marketplace/' );
		if ( ! $city_id && ! $specialty_id ) {
			return $base;
		}
		$args = array_filter( [ 'city_id' => $city_id ?: null, 'specialty_id' => $specialty_id ?: null ] );
		return add_query_arg( $args, $base );
	}

	if ( is_singular() ) {
		return get_permalink() ?: null;
	}

	if ( is_front_page() ) {
		return home_url( '/' );
	}

	if ( is_page() ) {
		return get_permalink() ?: null;
	}

	return null;
}

/**
 * Account-only surfaces (dashboard, auth) have no public value as a search
 * result and no other page in this codebase currently protects them from
 * indexing (confirmed by inspection — WooCommerce protects its own
 * cart/checkout/account pages via wc_page_no_robots(), but nothing does the
 * same for BeauClick's own /dashboard/ or /auth/). A thin/zero-result
 * marketplace filter combination is noindex,follow rather than fully
 * blocked — a crawler should still be free to follow its links back to the
 * pages that ARE worth indexing, just not index the thin page itself.
 */
function bc_filter_wp_robots( array $robots ): array {
	if ( is_page( [ 'dashboard', 'auth' ] ) ) {
		$robots['noindex']  = true;
		$robots['nofollow'] = true;
		return $robots;
	}

	if ( is_page( 'marketplace' ) ) {
		$city_id_raw      = isset( $_GET['city_id'] ) ? absint( $_GET['city_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$specialty_id_raw = isset( $_GET['specialty_id'] ) ? absint( $_GET['specialty_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( $city_id_raw || $specialty_id_raw ) {
			[ $city_id, $specialty_id ] = bc_get_meaningful_marketplace_filters();
			if ( ! $city_id && ! $specialty_id ) {
				$robots['noindex'] = true;
			}
		}
	}

	return $robots;
}

/**
 * Real structured data only — every field emitted here comes from actual
 * rendered page data, never fabricated (no invented ratings/prices/hours,
 * per this step's own explicit instruction). WooCommerce's own templates
 * already emit Product/BreadcrumbList JSON-LD on shop pages (see this
 * file's top docblock), so this function never runs on those.
 */
function bc_render_structured_data(): void {
	$graph = [];

	if ( is_singular( [ 'bc_professional', 'bc_business' ] ) ) {
		$graph[] = bc_structured_data_for_provider( get_the_ID() );
		$breadcrumb = bc_breadcrumb_for_provider( get_the_ID() );
		if ( $breadcrumb ) {
			$graph[] = $breadcrumb;
		}
	} elseif ( is_front_page() ) {
		$graph[] = [
			'@context' => 'https://schema.org',
			'@type'    => 'WebSite',
			'name'     => 'BeauClick',
			'url'      => home_url( '/' ),
			'inLanguage' => 'fa-IR',
		];
		$graph[] = [
			'@context' => 'https://schema.org',
			'@type'    => 'Organization',
			'name'     => 'BeauClick',
			'url'      => home_url( '/' ),
		];
	} elseif ( is_page( 'marketplace' ) ) {
		[ $city_id, $specialty_id ] = bc_get_meaningful_marketplace_filters();
		if ( $city_id || $specialty_id ) {
			$graph[] = bc_breadcrumb_for_marketplace( $city_id, $specialty_id );
		}
	}

	if ( ! $graph ) {
		return;
	}

	$payload = 1 === count( $graph ) ? $graph[0] : [ '@context' => 'https://schema.org', '@graph' => $graph ];
	echo '<script type="application/ld+json">' . wp_json_encode( $payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) . '</script>' . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
}

/** @return array<string,mixed> */
function bc_structured_data_for_provider( int $provider_id ): array {
	$index_row   = bc_get_provider_index_row( $provider_id );
	$specialties = wp_get_post_terms( $provider_id, 'bc_specialty', [ 'fields' => 'names' ] );
	$city_name   = $index_row && ! empty( $index_row['city_id'] ) ? bc_get_city_name( (int) $index_row['city_id'] ) : '';

	$data = [
		'@context' => 'https://schema.org',
		'@type'    => 'LocalBusiness',
		'name'     => get_the_title( $provider_id ),
		'url'      => get_permalink( $provider_id ),
		'description' => wp_strip_all_tags( get_the_content( null, false, $provider_id ) ) ?: null,
	];

	if ( $city_name ) {
		// No street address is ever collected for a professional's profile
		// today -- only a city -- so `address` stays a plain, honest
		// addressLocality-only PostalAddress rather than inventing a
		// streetAddress/postalCode this data doesn't have.
		$data['address'] = [
			'@type'          => 'PostalAddress',
			'addressLocality' => $city_name,
			'addressCountry'  => 'IR',
		];
	}

	if ( $specialties ) {
		$data['makesOffer'] = array_map(
			static fn ( string $name ) => [ '@type' => 'Offer', 'itemOffered' => [ '@type' => 'Service', 'name' => $name ] ],
			(array) $specialties
		);
	}

	// Only a review_count > 0 gets an aggregateRating -- never a fabricated
	// default (e.g. a brand-new professional with zero real reviews must
	// never claim a rating in structured data).
	if ( $index_row && (int) $index_row['review_count'] > 0 ) {
		$data['aggregateRating'] = [
			'@type'       => 'AggregateRating',
			'ratingValue' => (float) $index_row['rating_avg'],
			'reviewCount' => (int) $index_row['review_count'],
		];
	}

	return array_filter( $data, static fn ( $v ) => null !== $v );
}

/** @return array<string,mixed>|null */
function bc_breadcrumb_for_provider( int $provider_id ): ?array {
	$index_row = bc_get_provider_index_row( $provider_id );
	$items     = [
		[ '@type' => 'ListItem', 'position' => 1, 'name' => 'BeauClick', 'item' => home_url( '/' ) ],
		[ '@type' => 'ListItem', 'position' => 2, 'name' => 'متخصصان', 'item' => home_url( '/marketplace/' ) ],
	];
	if ( $index_row && ! empty( $index_row['city_id'] ) ) {
		$city_name = bc_get_city_name( (int) $index_row['city_id'] );
		if ( $city_name ) {
			$items[] = [
				'@type'    => 'ListItem',
				'position' => 3,
				'name'     => $city_name,
				'item'     => add_query_arg( 'city_id', (int) $index_row['city_id'], home_url( '/marketplace/' ) ),
			];
		}
	}
	$items[] = [ '@type' => 'ListItem', 'position' => count( $items ) + 1, 'name' => get_the_title( $provider_id ) ];

	return [ '@context' => 'https://schema.org', '@type' => 'BreadcrumbList', 'itemListElement' => $items ];
}

/** @return array<string,mixed> */
function bc_breadcrumb_for_marketplace( int $city_id, int $specialty_id ): array {
	$items = [
		[ '@type' => 'ListItem', 'position' => 1, 'name' => 'BeauClick', 'item' => home_url( '/' ) ],
		[ '@type' => 'ListItem', 'position' => 2, 'name' => 'متخصصان', 'item' => home_url( '/marketplace/' ) ],
	];
	$position = 3;
	if ( $city_id ) {
		$items[] = [
			'@type'    => 'ListItem',
			'position' => $position++,
			'name'     => bc_get_city_name( $city_id ),
			'item'     => add_query_arg( 'city_id', $city_id, home_url( '/marketplace/' ) ),
		];
	}
	if ( $specialty_id ) {
		$items[] = [
			'@type'    => 'ListItem',
			'position' => $position,
			'name'     => bc_get_specialty_name( $specialty_id ),
		];
	}
	return [ '@context' => 'https://schema.org', '@type' => 'BreadcrumbList', 'itemListElement' => $items ];
}
