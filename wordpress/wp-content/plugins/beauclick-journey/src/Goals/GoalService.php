<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Goals;

/**
 * A customer's specific, nameable, optionally time-boxed objectives —
 * distinct from BeautyProfileService's general ongoing preferences. Goals
 * are never destructively deleted (status transitions to 'achieved'/
 * 'abandoned' instead) so a completed goal remains part of the customer's
 * own journey history rather than vanishing.
 */
final class GoalService {

	public const STATUSES = [ 'active', 'achieved', 'abandoned' ];

	/** @return array<int, array<string, mixed>> */
	public function for_user( int $userId, ?string $status = null ): array {
		global $wpdb;
		$sql = "SELECT * FROM {$wpdb->prefix}bc_beauty_goals WHERE user_id = %d";
		$params = [ $userId ];
		if ( $status ) {
			$sql     .= ' AND status = %s';
			$params[] = $status;
		}
		$sql .= ' ORDER BY created_at DESC';

		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	public function find( int $goalId ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_beauty_goals WHERE id = %d", $goalId ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format( $row ) : null;
	}

	/**
	 * @return array<string, mixed>|string A goal array on success, or a
	 * user-facing Persian error string on invalid input -- same three-way
	 * REST-mappable shape ReviewService::create()/AssistantService::send()
	 * already use elsewhere in this codebase.
	 */
	public function create( int $userId, string $title, ?int $specialtyId, ?int $cityId, ?int $budget, ?string $targetDate ): array|string {
		$title = trim( sanitize_text_field( $title ) );
		if ( '' === $title ) {
			return 'عنوان هدف را وارد کنید.';
		}
		if ( mb_strlen( $title ) > 191 ) {
			return 'عنوان هدف بیش از حد طولانی است.';
		}

		global $wpdb;
		$now = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_beauty_goals',
			[
				'user_id'      => $userId,
				'title'        => $title,
				'specialty_id' => $specialtyId ?: null,
				'city_id'      => $cityId ?: null,
				'budget'       => $budget ?: null,
				'target_date'  => $targetDate ?: null,
				'status'       => 'active',
				'created_at'   => $now,
				'updated_at'   => $now,
			]
		);
		$goal_id = $wpdb->insert_id;

		// Only reachable after a genuine INSERT -- this event can never
		// double-log for the same goal, the same guarantee booking_created/
		// review_submitted already rely on elsewhere in this codebase.
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'goal_created', 'goal', $goal_id, $userId, [ 'title' => $title ] );
		}

		return $this->find( $goal_id );
	}

	/**
	 * Ownership is checked by the caller (Rest\JourneyController), same
	 * "check ownership in the controller before calling the service"
	 * pattern ReviewService::respond() and MyProfileController::update_service()
	 * already establish.
	 *
	 * @param array{title?: string, specialtyId?: int|null, cityId?: int|null, budget?: int|null, targetDate?: string|null, status?: string} $fields
	 * @return array<string, mixed>|string
	 */
	public function update( int $goalId, array $fields ): array|string {
		if ( isset( $fields['status'] ) && ! in_array( $fields['status'], self::STATUSES, true ) ) {
			return 'وضعیت هدف نامعتبر است.';
		}

		global $wpdb;
		$data   = [];
		$format = [];

		if ( array_key_exists( 'title', $fields ) ) {
			$title = trim( sanitize_text_field( (string) $fields['title'] ) );
			if ( '' === $title ) {
				return 'عنوان هدف را وارد کنید.';
			}
			$data['title'] = mb_substr( $title, 0, 191 );
			$format[]      = '%s';
		}
		if ( array_key_exists( 'specialtyId', $fields ) ) {
			$data['specialty_id'] = $fields['specialtyId'] ?: null;
			$format[]             = '%d';
		}
		if ( array_key_exists( 'cityId', $fields ) ) {
			$data['city_id'] = $fields['cityId'] ?: null;
			$format[]        = '%d';
		}
		if ( array_key_exists( 'budget', $fields ) ) {
			$data['budget'] = $fields['budget'] ?: null;
			$format[]       = '%d';
		}
		if ( array_key_exists( 'targetDate', $fields ) ) {
			$data['target_date'] = $fields['targetDate'] ?: null;
			$format[]            = '%s';
		}
		if ( array_key_exists( 'status', $fields ) ) {
			$data['status'] = $fields['status'];
			$format[]       = '%s';
		}

		if ( ! $data ) {
			return $this->find( $goalId ) ?? 'هدف پیدا نشد.';
		}

		$data['updated_at'] = current_time( 'mysql' );
		$format[]            = '%s';

		$wpdb->update( $wpdb->prefix . 'bc_beauty_goals', $data, [ 'id' => $goalId ], $format, [ '%d' ] );

		return $this->find( $goalId ) ?? 'هدف پیدا نشد.';
	}

	private function format( array $row ): array {
		return [
			'id'          => (int) $row['id'],
			'userId'      => (int) $row['user_id'],
			'title'       => $row['title'],
			'specialtyId' => $row['specialty_id'] ? (int) $row['specialty_id'] : null,
			'cityId'      => $row['city_id'] ? (int) $row['city_id'] : null,
			'budget'      => null !== $row['budget'] ? (int) $row['budget'] : null,
			'targetDate'  => $row['target_date'],
			'status'      => $row['status'],
			'createdAt'   => $row['created_at'],
		];
	}
}
