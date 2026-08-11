<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\PostTypes;

/**
 * CPTs + the specialty taxonomy. Ownership uses WordPress's own
 * `post_author` (the professional/business's wp_users.ID) rather than a
 * separate meta field — it's exactly what post_author is for, and every
 * WP capability/query helper already understands it.
 *
 * Only editorial content lives here (bio, portfolio, services, pricing) —
 * the searchable/filterable attributes are denormalized into
 * wp_bc_provider_index (Search\Indexer) because meta queries don't index
 * combinations well at marketplace scale (architecture doc §11).
 */
final class Registrar {

	public const PROFESSIONAL   = 'bc_professional';
	public const BUSINESS       = 'bc_business';
	public const SERVICE        = 'bc_service';
	public const PORTFOLIO_ITEM = 'bc_portfolio_item';
	public const SPECIALTY      = 'bc_specialty';

	public function register(): void {
		add_action( 'init', [ $this, 'register_post_types' ] );
		add_action( 'init', [ $this, 'register_taxonomy' ] );
	}

	public function register_post_types(): void {
		register_post_type(
			self::PROFESSIONAL,
			[
				'labels'             => [
					'name'          => __( 'Professionals', 'beauclick-marketplace' ),
					'singular_name' => __( 'Professional', 'beauclick-marketplace' ),
				],
				'public'             => true,
				'publicly_queryable' => true,
				'show_in_rest'       => true,
				'has_archive'        => false,
				'rewrite'            => [ 'slug' => 'professional' ],
				'supports'           => [ 'title', 'editor', 'thumbnail', 'author' ],
				'capability_type'    => [ 'bc_professional', 'bc_professionals' ],
				'map_meta_cap'       => true,
			]
		);

		register_post_type(
			self::BUSINESS,
			[
				'labels'             => [
					'name'          => __( 'Businesses', 'beauclick-marketplace' ),
					'singular_name' => __( 'Business', 'beauclick-marketplace' ),
				],
				'public'             => true,
				'publicly_queryable' => true,
				'show_in_rest'       => true,
				'has_archive'        => false,
				'rewrite'            => [ 'slug' => 'business' ],
				'supports'           => [ 'title', 'editor', 'thumbnail', 'author' ],
				'capability_type'    => [ 'bc_business_listing', 'bc_business_listings' ],
				'map_meta_cap'       => true,
			]
		);

		register_post_type(
			self::SERVICE,
			[
				'labels'             => [
					'name'          => __( 'Services', 'beauclick-marketplace' ),
					'singular_name' => __( 'Service', 'beauclick-marketplace' ),
				],
				'public'             => false,
				'publicly_queryable' => false,
				'show_in_rest'       => true,
				'supports'           => [ 'title', 'author' ],
				'capability_type'    => [ 'bc_service', 'bc_services' ],
				'map_meta_cap'       => true,
			]
		);

		register_post_type(
			self::PORTFOLIO_ITEM,
			[
				'labels'             => [
					'name'          => __( 'Portfolio Items', 'beauclick-marketplace' ),
					'singular_name' => __( 'Portfolio Item', 'beauclick-marketplace' ),
				],
				'public'             => false,
				'publicly_queryable' => false,
				'show_in_rest'       => true,
				'supports'           => [ 'title', 'thumbnail', 'author' ],
				'capability_type'    => [ 'bc_portfolio_item', 'bc_portfolio_items' ],
				'map_meta_cap'       => true,
			]
		);
	}

	public function register_taxonomy(): void {
		register_taxonomy(
			self::SPECIALTY,
			[ self::PROFESSIONAL, self::BUSINESS, self::SERVICE ],
			[
				'labels'       => [
					'name'          => __( 'Specialties', 'beauclick-marketplace' ),
					'singular_name' => __( 'Specialty', 'beauclick-marketplace' ),
				],
				'hierarchical' => true,
				'public'       => true,
				'show_in_rest' => true,
				'rewrite'      => [ 'slug' => 'specialty' ],
			]
		);
	}
}
