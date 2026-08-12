<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * Keeps wp_bc_provider_index in sync with the CPT data it's denormalized
 * from. Every write goes through here rather than ad-hoc $wpdb calls
 * scattered across hooks — one place to reason about what "the index" means.
 *
 * Rating/review_count start at 0 and are updated by beauclick-reviews once
 * that module exists (update_rating()) — a provider with zero reviews is a
 * legitimate, correctly-indexed state, not a sync failure.
 */
final class Indexer {

	public function register(): void {
		add_action( 'save_post_' . Registrar::PROFESSIONAL, [ $this, 'sync_from_post' ], 20, 2 );
		add_action( 'save_post_' . Registrar::BUSINESS, [ $this, 'sync_from_post' ], 20, 2 );
		add_action( 'save_post_' . Registrar::SERVICE, [ $this, 'sync_from_service_change' ], 20, 2 );
		add_action( 'before_delete_post', [ $this, 'remove_on_delete' ] );
		add_action( 'trashed_post', [ $this, 'remove_on_delete' ] );
	}

	public function sync_from_post( int $post_id, \WP_Post $post ): void {
		if ( wp_is_post_revision( $post_id ) || wp_is_post_autosave( $post_id ) ) {
			return;
		}
		$this->sync( $post_id, $post->post_type );
	}

	/**
	 * A service's price/duration changing affects its parent provider's
	 * price_from — resync the parent, not the service itself (services
	 * aren't independently searchable, they don't get their own index row).
	 */
	public function sync_from_service_change( int $service_id, \WP_Post $post ): void {
		if ( wp_is_post_revision( $service_id ) || wp_is_post_autosave( $service_id ) || ! $post->post_parent ) {
			return;
		}
		$parent = get_post( $post->post_parent );
		if ( $parent ) {
			$this->sync( $parent->ID, $parent->post_type );
		}
	}

	public function remove_on_delete( int $post_id ): void {
		$post = get_post( $post_id );
		if ( ! $post || ! in_array( $post->post_type, [ Registrar::PROFESSIONAL, Registrar::BUSINESS ], true ) ) {
			return;
		}
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'bc_provider_index', [ 'provider_id' => $post_id, 'provider_type' => $post->post_type ] );
	}

	public function sync( int $post_id, string $post_type ): void {
		if ( ! in_array( $post_type, [ Registrar::PROFESSIONAL, Registrar::BUSINESS ], true ) ) {
			return;
		}

		$post = get_post( $post_id );
		if ( ! $post || 'publish' !== $post->post_status ) {
			$this->remove_on_delete( $post_id );
			return;
		}

		global $wpdb;
		$table = $wpdb->prefix . 'bc_provider_index';

		$specialty_ids = wp_get_post_terms( $post_id, Registrar::SPECIALTY, [ 'fields' => 'ids' ] );
		$price_from    = $this->min_service_price( $post_id );

		$existing_rating = $wpdb->get_row(
			$wpdb->prepare( "SELECT rating_avg, review_count FROM {$table} WHERE provider_id = %d AND provider_type = %s", $post_id, $post_type ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		$wpdb->replace(
			$table,
			[
				'provider_id'    => $post_id,
				'provider_type'  => $post_type,
				'owner_user_id'  => (int) $post->post_author,
				'name'           => $post->post_title,
				'city_id'        => get_post_meta( $post_id, '_bc_city_id', true ) ?: null,
				'district_id'    => get_post_meta( $post_id, '_bc_district_id', true ) ?: null,
				'specialty_ids'  => $specialty_ids ? implode( ',', $specialty_ids ) : null,
				'price_from'     => $price_from,
				'rating_avg'     => $existing_rating['rating_avg'] ?? 0,
				'review_count'   => $existing_rating['review_count'] ?? 0,
				'verified'       => 'verified' === get_post_meta( $post_id, '_bc_verification_status', true ) ? 1 : 0,
				'last_active_at' => current_time( 'mysql' ),
				'updated_at'     => current_time( 'mysql' ),
			]
		);

		// V2.0 Step 3: the one new seam ranking needs. beauclick-booking's
		// Ranking module (see its own docblock for why the compute side
		// lives there, not here) subscribes to this to recompute one
		// provider's ranking_score right after its index row changes —
		// same hook-based, one-way, source-fires/consumer-subscribes
		// convention as every other cross-plugin seam in this codebase
		// (beauclick/booking/completed, beauclick/reviews/submitted), not a
		// new pattern. Fired unconditionally on every sync(), including
		// edits — a single-provider recompute is a handful of indexed
		// queries, cheap enough to run on every profile/service edit at
		// this project's realistic provider-count scale (see
		// RankingEngine::recompute_one()'s own docblock for the "why now,
		// why not later" note if that stops being true).
		do_action( 'beauclick/marketplace/provider_indexed', $post_id, $post_type );
	}

	public function update_rating( int $provider_id, string $provider_type, float $rating_avg, int $review_count ): void {
		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_provider_index',
			[ 'rating_avg' => $rating_avg, 'review_count' => $review_count, 'updated_at' => current_time( 'mysql' ) ],
			[ 'provider_id' => $provider_id, 'provider_type' => $provider_type ]
		);
	}

	/**
	 * V2.0 Step 3 — the one write path for ranking output, called by
	 * beauclick-booking's RankingEngine after it computes a score. Mirrors
	 * update_rating()'s exact shape: a plugin that doesn't own this table
	 * writes into it through a method marketplace itself owns, not raw SQL
	 * reaching across the plugin boundary.
	 *
	 * @param array<int, string> $signalKeys
	 */
	public function update_ranking( int $provider_id, string $provider_type, float $score, array $signalKeys ): void {
		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_provider_index',
			[
				'ranking_score'   => round( $score, 4 ),
				'ranking_signals' => $signalKeys ? wp_json_encode( array_values( $signalKeys ) ) : null,
			],
			[ 'provider_id' => $provider_id, 'provider_type' => $provider_type ]
		);
	}

	private function min_service_price( int $provider_id ): ?int {
		global $wpdb;
		$min = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT MIN(CAST(pm.meta_value AS UNSIGNED))
				 FROM {$wpdb->posts} p
				 INNER JOIN {$wpdb->postmeta} pm ON pm.post_id = p.ID AND pm.meta_key = '_bc_price'
				 WHERE p.post_parent = %d AND p.post_type = %s AND p.post_status = 'publish'",
				$provider_id,
				Registrar::SERVICE
			)
		);
		return null !== $min ? (int) $min : null;
	}
}
