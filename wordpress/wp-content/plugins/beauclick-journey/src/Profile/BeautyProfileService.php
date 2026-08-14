<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Profile;

/**
 * A customer's ongoing, low-commitment preferences — one row per user
 * (like wp_bc_ai_conversations' own UNIQUE user_id shape). Deliberately
 * small and structured, not a JSON blob: every field here is something a
 * future query/filter/AI-context lookup genuinely needs, per the task's own
 * "prefer relational tables when data will be queried/filtered/used by AI"
 * instruction.
 */
final class BeautyProfileService {

	/** @return array<string, mixed> A default (all-null) shape if the customer never set a profile — never a 404, an empty profile is a legitimate state. */
	public function get( int $userId ): array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_beauty_profiles WHERE user_id = %d", $userId ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return $this->format( $userId, $row );
	}

	/**
	 * @param array{preferredCityId?: int|null, preferredSpecialtyIds?: array<int,int>, budgetMin?: int|null, budgetMax?: int|null, notes?: string|null} $fields
	 * Only keys present in $fields are changed -- an omitted key leaves the
	 * existing stored value untouched (PATCH semantics), matching
	 * MyProfileController::update_profile()'s existing convention elsewhere
	 * in this codebase.
	 */
	public function update( int $userId, array $fields ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_beauty_profiles';
		$now   = current_time( 'mysql' );

		$exists = (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$table} WHERE user_id = %d", $userId ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		$data   = [];
		$format = [];

		if ( array_key_exists( 'preferredCityId', $fields ) ) {
			$data['preferred_city_id'] = $fields['preferredCityId'] ?: null;
			$format[]                  = '%d';
		}
		if ( array_key_exists( 'preferredSpecialtyIds', $fields ) ) {
			$ids                              = array_map( 'intval', (array) $fields['preferredSpecialtyIds'] );
			$data['preferred_specialty_ids']  = $ids ? implode( ',', $ids ) : null;
			$format[]                         = '%s';
		}
		if ( array_key_exists( 'budgetMin', $fields ) ) {
			$data['budget_min'] = $fields['budgetMin'] ?: null;
			$format[]           = '%d';
		}
		if ( array_key_exists( 'budgetMax', $fields ) ) {
			$data['budget_max'] = $fields['budgetMax'] ?: null;
			$format[]           = '%d';
		}
		if ( array_key_exists( 'notes', $fields ) ) {
			// Customer-authored, short, non-medical -- see this table's own
			// migration docblock. Length-capped to match the column and to
			// keep this from silently becoming a place to paste long text.
			// An empty string clears it to NULL, same "falsy means clear"
			// convention every other field on this endpoint already uses.
			$trimmed        = trim( sanitize_textarea_field( (string) $fields['notes'] ) );
			$data['notes']  = '' !== $trimmed ? mb_substr( $trimmed, 0, 500 ) : null;
			$format[]       = '%s';
		}

		if ( ! $data ) {
			return $this->get( $userId );
		}

		if ( $exists ) {
			$data['updated_at'] = $now;
			$format[]            = '%s';
			$wpdb->update( $table, $data, [ 'user_id' => $userId ], $format, [ '%d' ] );
		} else {
			$data['user_id']    = $userId;
			$data['created_at'] = $now;
			$data['updated_at'] = $now;
			$wpdb->insert( $table, $data );
		}

		return $this->get( $userId );
	}

	/**
	 * V2.2 Step 14 — genuinely customer-owned preference data (city/specialty/
	 * budget/notes), of no legitimate interest to any other party once the
	 * account is gone, unlike a CRM note or a chat message a professional
	 * also has a stake in. Deleted outright, not anonymized. Idempotent — a
	 * customer who never set a profile has no row to delete, and a repeated
	 * call after a resumed deletion sweep is a harmless no-op.
	 */
	public function forget_user( int $userId ): void {
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'bc_beauty_profiles', [ 'user_id' => $userId ], [ '%d' ] );
	}

	private function format( int $userId, ?array $row ): array {
		if ( ! $row ) {
			return [
				'userId'                => $userId,
				'preferredCityId'       => null,
				'preferredSpecialtyIds' => [],
				'budgetMin'             => null,
				'budgetMax'             => null,
				'notes'                 => null,
			];
		}

		return [
			'userId'                => $userId,
			'preferredCityId'       => $row['preferred_city_id'] ? (int) $row['preferred_city_id'] : null,
			'preferredSpecialtyIds' => $row['preferred_specialty_ids'] ? array_map( 'intval', explode( ',', $row['preferred_specialty_ids'] ) ) : [],
			'budgetMin'             => null !== $row['budget_min'] ? (int) $row['budget_min'] : null,
			'budgetMax'             => null !== $row['budget_max'] ? (int) $row['budget_max'] : null,
			'notes'                 => $row['notes'],
		];
	}
}
