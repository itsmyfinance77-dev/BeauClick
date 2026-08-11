<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * Default provider when BC_AI_API_KEY isn't configured (every local/dev
 * install, and — per architecture doc §16 — a real operational fallback for
 * production too, since major AI providers generally restrict direct API
 * access from Iranian IPs and that infra decision may not be resolved by
 * launch). Deterministic and free: reads real catalog data via
 * ContextExtractor + wp_bc_provider_index rather than calling out to
 * anything, so recommendations are always genuine rows, never placeholders.
 */
final class RuleBasedProvider implements ProviderInterface {

	public function __construct( private readonly ContextExtractor $extractor = new ContextExtractor() ) {
	}

	public function chat( array $history, array $context ): AssistantResponse {
		$latest = end( $history );
		$text   = $latest && 'user' === $latest['role'] ? $latest['content'] : '';

		$updates = [];
		if ( $specialty_ids = $this->extractor->extract_specialty_ids( $text ) ) {
			$updates['specialtyIds'] = $specialty_ids;
		}
		if ( $city_id = $this->extractor->extract_city_id( $text ) ) {
			$updates['cityId'] = $city_id;
		}
		if ( $budget = $this->extractor->extract_budget( $text ) ) {
			$updates['budget'] = $budget;
		}

		$merged = array_merge( $context, $updates );

		if ( empty( $merged['specialtyIds'] ) ) {
			return new AssistantResponse(
				'سلام! برای اینکه بهترین متخصص یا محصول رو بهت پیشنهاد بدم، بگو دنبال چه خدمتی هستی — مثلاً میکاپ، رنگ مو یا مراقبت پوست؟',
				[],
				$updates
			);
		}

		$providers = $this->find_providers( $merged );

		if ( ! $providers ) {
			return new AssistantResponse(
				empty( $merged['cityId'] )
					? 'در چه شهری دنبال متخصص می‌گردی؟ با دونستن شهرت می‌تونم گزینه‌های واقعی رو نشونت بدم.'
					: 'متأسفانه با این مشخصات متخصصی پیدا نکردم — می‌تونی شهر یا بودجه رو تغییر بدی؟',
				[],
				$updates
			);
		}

		$names = implode( '، ', array_map( static fn ( array $p ) => $p['name'], $providers ) );
		$reply = "بر اساس چیزی که گفتی، این گزینه‌ها رو پیشنهاد می‌کنم: {$names}. می‌تونی از روی کارت‌ها مستقیم رزرو کنی.";

		return new AssistantResponse(
			$reply,
			array_map( static fn ( array $p ) => [ 'type' => 'provider', 'id' => $p['provider_id'] ], $providers ),
			$updates
		);
	}

	/** @return array<int, array{provider_id: int, name: string}> */
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

		$sql = 'SELECT provider_id, name FROM ' . $wpdb->prefix . 'bc_provider_index WHERE ' . implode( ' AND ', $where ) . ' ORDER BY verified DESC, rating_avg DESC LIMIT 3';
		$sql = $params ? $wpdb->prepare( $sql, $params ) : $sql; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results( $sql, ARRAY_A );

		return array_map(
			static fn ( array $r ) => [ 'provider_id' => (int) $r['provider_id'], 'name' => $r['name'] ],
			$rows ?: []
		);
	}
}
