<?php
declare( strict_types=1 );

namespace BeauClick\AI;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Ranking\RankingPresenter;

/**
 * Default provider when BC_AI_API_KEY isn't configured (every local/dev
 * install, and — per architecture doc §16 — a real operational fallback for
 * production too, since major AI providers generally restrict direct API
 * access from Iranian IPs and that infra decision may not be resolved by
 * launch). Deterministic and free: reads real catalog data via
 * ContextExtractor + wp_bc_provider_index/WooCommerce/bc_service rather than
 * calling out to anything, so recommendations are always genuine rows,
 * never placeholders.
 *
 * V2.0 Step 2: extended from professional-only recommendations into a real
 * discovery engine — products and services now match too, each with a
 * short explanation grounded in the actual matched data (category name,
 * specialty, price), never an invented claim. A conservative medical-safety
 * check runs before any recommendation logic; see MedicalSafetyGuard.
 */
final class RuleBasedProvider implements ProviderInterface {

	private const MAX_RECOMMENDATIONS = 4;

	public function __construct(
		private readonly ContextExtractor $extractor = new ContextExtractor(),
		private readonly MedicalSafetyGuard $medicalGuard = new MedicalSafetyGuard()
	) {
	}

	public function chat( array $history, array $context ): AssistantResponse {
		$latest = end( $history );
		$text   = $latest && 'user' === $latest['role'] ? $latest['content'] : '';

		if ( $this->medicalGuard->is_medical_concern( $text ) ) {
			return new AssistantResponse( $this->medicalGuard->cautious_reply() );
		}

		$updates = [];
		if ( $specialty_ids = $this->extractor->extract_specialty_ids( $text ) ) {
			$updates['specialtyIds'] = $specialty_ids;
		}
		if ( $category_ids = $this->extractor->extract_product_category_ids( $text ) ) {
			$updates['productCategoryIds'] = $category_ids;
		}
		if ( $city_id = $this->extractor->extract_city_id( $text ) ) {
			$updates['cityId'] = $city_id;
		}
		if ( $budget = $this->extractor->extract_budget( $text ) ) {
			$updates['budget'] = $budget;
		}

		$merged = array_merge( $context, $updates );

		if ( empty( $merged['specialtyIds'] ) && empty( $merged['productCategoryIds'] ) ) {
			return new AssistantResponse(
				'سلام! برای اینکه بهترین متخصص یا محصول رو بهت پیشنهاد بدم، بگو دنبال چه چیزی هستی — مثلاً میکاپ، رنگ مو، مراقبت پوست یا یه محصول خاص؟',
				[],
				$updates
			);
		}

		$recommendations = [];

		if ( ! empty( $merged['productCategoryIds'] ) ) {
			array_push( $recommendations, ...$this->find_products( $merged ) );
		}
		if ( ! empty( $merged['specialtyIds'] ) ) {
			array_push( $recommendations, ...$this->find_services( $merged ) );
			array_push( $recommendations, ...$this->find_providers( $merged ) );
		}

		$recommendations = array_slice( $recommendations, 0, self::MAX_RECOMMENDATIONS );

		if ( ! $recommendations ) {
			return new AssistantResponse( $this->no_match_reply( $merged ), [], $updates );
		}

		return new AssistantResponse( $this->summary_reply( $recommendations ), $recommendations, $updates );
	}

	private function no_match_reply( array $context ): string {
		if ( ! empty( $context['specialtyIds'] ) && empty( $context['cityId'] ) ) {
			return 'در چه شهری دنبال متخصص می‌گردی؟ با دونستن شهرت می‌تونم گزینه‌های واقعی رو نشونت بدم.';
		}
		return 'متأسفانه با این مشخصات چیزی پیدا نکردم — می‌تونی شهر، بودجه یا نوع خدمت/محصول رو تغییر بدی تا دوباره بگردم؟';
	}

	private function summary_reply( array $recommendations ): string {
		$has_product  = (bool) array_filter( $recommendations, static fn ( array $r ) => 'product' === $r['type'] );
		$has_service  = (bool) array_filter( $recommendations, static fn ( array $r ) => 'service' === $r['type'] );
		$has_provider = (bool) array_filter( $recommendations, static fn ( array $r ) => 'provider' === $r['type'] );

		$parts = [];
		if ( $has_product ) {
			$parts[] = 'چند محصول متناسب';
		}
		if ( $has_service ) {
			$parts[] = 'چند خدمت';
		}
		if ( $has_provider ) {
			$parts[] = 'چند متخصص واقعی';
		}

		return 'بر اساس چیزی که گفتی، ' . implode( ' و ', $parts ) . ' برات پیدا کردم — از روی کارت‌ها می‌تونی مستقیم ادامه بدی.';
	}

	/** @return array<int, array{type: string, id: int, reason: string}> */
	private function find_products( array $context ): array {
		if ( ! function_exists( 'wc_get_products' ) ) {
			return [];
		}

		$slugs = [];
		$names = [];
		foreach ( (array) $context['productCategoryIds'] as $term_id ) {
			$term = get_term( (int) $term_id, 'product_cat' );
			if ( $term && ! is_wp_error( $term ) ) {
				$slugs[] = $term->slug;
				$names[] = $term->name;
			}
		}
		if ( ! $slugs ) {
			return [];
		}

		// Fetch a slightly larger candidate set than we'll return — budget
		// filtering happens in PHP against the product's own real price
		// (WooCommerce has no built-in max-price query arg), then the
		// result is capped. wc_get_products() with only 'status' => publish
		// does NOT exclude catalog_visibility=hidden products (those are
		// still real, published rows — just excluded from Shop browsing) —
		// ServiceProductSync creates exactly such hidden products for every
		// bookable service, so is_visible() is checked explicitly here, not
		// just left to AssistantService's downstream validation, so a
		// booking-only product is never even offered as a Shop-style
		// recommendation in the first place.
		$candidates = wc_get_products(
			[
				'category' => $slugs,
				'status'   => 'publish',
				'orderby'  => 'date',
				'limit'    => 10,
			]
		);

		$budget = ! empty( $context['budget'] ) ? (int) $context['budget'] : null;
		$out    = [];

		foreach ( $candidates as $product ) {
			if ( ! $product->is_visible() ) {
				continue;
			}
			$price = (int) $product->get_price();
			if ( null !== $budget && $price > $budget ) {
				continue;
			}

			$out[] = [
				'type'   => 'product',
				'id'     => $product->get_id(),
				'reason' => sprintf( 'برای %s پیشنهاد می‌شه.', $names[0] ),
			];

			if ( count( $out ) >= 3 ) {
				break;
			}
		}

		return $out;
	}

	/** @return array<int, array{type: string, id: int, reason: string}> */
	private function find_services( array $context ): array {
		$query_args = [
			'post_type'      => Registrar::SERVICE,
			'post_status'    => 'publish',
			// A city filter (below) is applied in PHP against the PARENT
			// provider's own city meta -- a service post carries no city of
			// its own -- so a wider candidate set than the final cap is
			// fetched here, the same tradeoff find_products() makes for its
			// budget filter.
			'posts_per_page' => 10,
			'tax_query'      => [ // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
				[
					'taxonomy' => Registrar::SPECIALTY,
					'field'    => 'term_id',
					'terms'    => array_map( 'intval', (array) $context['specialtyIds'] ),
				],
			],
		];

		if ( ! empty( $context['budget'] ) ) {
			$query_args['meta_query'] = [ // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
				[
					'key'     => '_bc_price',
					'value'   => (int) $context['budget'],
					'compare' => '<=',
					'type'    => 'NUMERIC',
				],
			];
		}

		$services = get_posts( $query_args );
		$city_id  = ! empty( $context['cityId'] ) ? (int) $context['cityId'] : null;
		$out      = [];

		foreach ( $services as $service ) {
			// Belt-and-suspenders: a service's parent provider must itself
			// still be published, or the "service detail" it would deep-
			// link into (the provider's own profile page) wouldn't exist.
			$parent = get_post( $service->post_parent );
			if ( ! $parent || 'publish' !== $parent->post_status ) {
				continue;
			}

			// A service post has no city of its own -- it inherits its
			// parent provider's. When the user named a city, a service from
			// a provider in a DIFFERENT city must never be recommended, even
			// if the specialty matches (live verification caught exactly
			// this: a hair-color service from an Isfahan provider surfacing
			// for a "in Yazd" request before this check existed).
			if ( null !== $city_id ) {
				$provider_city_id = (int) get_post_meta( $parent->ID, '_bc_city_id', true );
				if ( $provider_city_id !== $city_id ) {
					continue;
				}
			}

			$price = (int) get_post_meta( $service->ID, '_bc_price', true );
			$out[] = [
				'type'   => 'service',
				'id'     => $service->ID,
				'reason' => $price > 0
					? sprintf( 'خدمت «%1$s»، دقیقاً در همین حوزه.', $service->post_title )
					: sprintf( 'خدمت «%1$s»، مرتبط با درخواستت.', $service->post_title ),
			];

			if ( count( $out ) >= 2 ) {
				break;
			}
		}

		return $out;
	}

	/** @return array<int, array{type: string, id: int, reason: string}> */
	private function find_providers( array $context ): array {
		global $wpdb;

		$where  = [ '1=1' ];
		$params = [];

		if ( ! empty( $context['specialtyIds'] ) ) {
			$or = [];
			foreach ( (array) $context['specialtyIds'] as $id ) {
				$or[]     = 'FIND_IN_SET(%d, specialty_ids)';
				$params[] = (int) $id;
			}
			$where[] = '(' . implode( ' OR ', $or ) . ')';
		}
		if ( ! empty( $context['cityId'] ) ) {
			$where[]  = 'city_id = %d';
			$params[] = (int) $context['cityId'];
		}
		if ( ! empty( $context['budget'] ) ) {
			$where[]  = '(price_from IS NULL OR price_from <= %d)';
			$params[] = (int) $context['budget'];
		}

		// V2.0 Step 3: same shared ORDER BY every ranking consumer in the
		// codebase now uses (see RankingPresenter's own docblock) — AI still
		// owns candidate eligibility (the WHERE built above from
		// specialty/city/budget context), ranking only decides order among
		// those already-eligible candidates.
		$sql = 'SELECT provider_id, name, rating_avg, review_count FROM ' . $wpdb->prefix . 'bc_provider_index WHERE ' . implode( ' AND ', $where ) . ' ORDER BY ' . RankingPresenter::ORDER_BY . ' LIMIT 3';
		$sql = $params ? $wpdb->prepare( $sql, $params ) : $sql; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results( $sql, ARRAY_A );

		return array_map(
			static function ( array $r ): array {
				$rating = (float) $r['rating_avg'];
				// Every other user-facing number in this codebase renders in
				// Persian digits (dates, prices, dashboard stats) -- this was
				// the one AI-recommendation string still emitting raw Latin
				// digits, found during the Global UI/UX audit.
				$reason = $rating > 0
					? strtr(
						sprintf( 'متخصص با امتیاز %.1f از %d نظر.', $rating, (int) $r['review_count'] ),
						[ '0' => '۰', '1' => '۱', '2' => '۲', '3' => '۳', '4' => '۴', '5' => '۵', '6' => '۶', '7' => '۷', '8' => '۸', '9' => '۹' ]
					)
					: 'متخصص فعال، متناسب با درخواستت.';
				return [ 'type' => 'provider', 'id' => (int) $r['provider_id'], 'reason' => $reason ];
			},
			$rows ?: []
		);
	}
}
