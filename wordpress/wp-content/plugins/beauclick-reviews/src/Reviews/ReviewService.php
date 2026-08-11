<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Reviews;

use BeauClick\Marketplace\Search\Indexer;
use BeauClick\Reviews\Notifications\ReviewMailer;

/**
 * New reviews auto-approve (architecture doc §8 defines pending/approved/
 * rejected/flagged) — auto-approving on submit means the feature is
 * visible immediately rather than stuck behind a queue nobody could act
 * on before Phase 12's admin UI existed; moderate() (used by that UI) can
 * still demote a review to rejected/flagged after the fact, same schema
 * either way. Spam risk is bounded by construction: a review requires a
 * real completed booking the author owns, and the UNIQUE booking_id key
 * caps it at one review per booking ever.
 */
final class ReviewService {

	public const STATUSES = [ 'pending', 'approved', 'rejected', 'flagged' ];

	public function __construct( private readonly Indexer $indexer = new Indexer() ) {
	}

	/**
	 * @return array<string, mixed>|string An array on success, or a
	 * user-facing Persian error string on failure — the REST controller
	 * maps the string case to a 403/409 as appropriate.
	 */
	public function create( int $author_id, int $booking_id, int $rating, string $body ): array|string {
		if ( $rating < 1 || $rating > 5 ) {
			return 'امتیاز باید بین ۱ تا ۵ باشد.';
		}

		global $wpdb;
		$booking = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		if ( ! $booking || (int) $booking['customer_id'] !== $author_id ) {
			return 'این رزرو متعلق به شما نیست.';
		}
		if ( 'completed' !== $booking['status'] ) {
			return 'فقط پس از تکمیل نوبت می‌توانید نظر ثبت کنید.';
		}

		$already = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_reviews WHERE booking_id = %d", $booking_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( $already ) {
			return 'شما قبلاً برای این نوبت نظر ثبت کرده‌اید.';
		}

		$now = current_time( 'mysql' );
		$wpdb->insert(
			$wpdb->prefix . 'bc_reviews',
			[
				'author_id'   => $author_id,
				'target_type' => 'provider',
				'target_id'   => (int) $booking['provider_id'],
				'booking_id'  => $booking_id,
				'rating'      => $rating,
				'body'        => trim( $body ),
				'status'      => 'approved',
				'created_at'  => $now,
				'updated_at'  => $now,
			],
			[ '%d', '%s', '%d', '%d', '%d', '%s', '%s', '%s', '%s' ]
		);
		$review_id = $wpdb->insert_id;

		$this->resync_provider_rating( (int) $booking['provider_id'] );

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'review_submitted', 'provider', (int) $booking['provider_id'], $author_id, [ 'rating' => $rating ] );
		}

		$review = $this->find( $review_id );
		( new ReviewMailer() )->send_new_review( $review );

		return $review;
	}

	/**
	 * The admin moderation UI's only write path — approving/rejecting/
	 * flagging always resyncs the provider's rating, since only 'approved'
	 * reviews count toward it (for_provider()'s default and
	 * resync_provider_rating() both filter on status = 'approved').
	 */
	public function moderate( int $review_id, string $status ): bool {
		if ( ! in_array( $status, self::STATUSES, true ) ) {
			return false;
		}

		global $wpdb;
		$review = $this->find( $review_id );
		if ( ! $review ) {
			return false;
		}

		$wpdb->update(
			$wpdb->prefix . 'bc_reviews',
			[ 'status' => $status, 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $review_id ],
			[ '%s', '%s' ],
			[ '%d' ]
		);

		$this->resync_provider_rating( $review['targetId'] );

		return true;
	}

	/** @return array<int, array<string, mixed>> */
	public function all( int $limit = 100 ): array {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_reviews ORDER BY created_at DESC LIMIT %d", $limit ), ARRAY_A );
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function for_provider( int $provider_id, bool $only_approved = true ): array {
		global $wpdb;
		$where = $only_approved ? "AND status = 'approved'" : '';
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_reviews WHERE target_type = 'provider' AND target_id = %d {$where} ORDER BY created_at DESC", $provider_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/**
	 * Batch equivalent of for_provider() across several providers at once —
	 * a production-readiness audit found ReviewsController::my_reviews()
	 * calling for_provider() once per provider a user owns (N+1 for any
	 * multi-listing B2B account). One query with target_id IN (...) instead,
	 * already ordered globally so the caller no longer needs to merge-sort.
	 *
	 * @param array<int, int> $provider_ids
	 * @return array<int, array<string, mixed>>
	 */
	public function for_providers( array $provider_ids, bool $only_approved = true ): array {
		if ( ! $provider_ids ) {
			return [];
		}
		global $wpdb;
		$placeholders = implode( ',', array_fill( 0, count( $provider_ids ), '%d' ) );
		$where        = $only_approved ? "AND status = 'approved'" : '';
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_reviews WHERE target_type = 'provider' AND target_id IN ({$placeholders}) {$where} ORDER BY created_at DESC", // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
				$provider_ids
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	public function find( int $review_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_reviews WHERE id = %d", $review_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format( $row ) : null;
	}

	/**
	 * Ownership is against the review's TARGET provider, not the review
	 * itself — a professional responds to reviews written about them, they
	 * never edit the review's own content/rating.
	 */
	public function respond( int $review_id, int $professional_user_id, string $response ): bool {
		global $wpdb;
		$review = $wpdb->get_row( $wpdb->prepare( "SELECT target_id FROM {$wpdb->prefix}bc_reviews WHERE id = %d", $review_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( ! $review ) {
			return false;
		}

		$owner_id = (int) get_post_field( 'post_author', (int) $review['target_id'] );
		if ( $owner_id !== $professional_user_id ) {
			return false;
		}

		$wpdb->update(
			$wpdb->prefix . 'bc_reviews',
			[ 'response' => trim( $response ), 'response_at' => current_time( 'mysql' ), 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $review_id ],
			[ '%s', '%s', '%s' ],
			[ '%d' ]
		);
		return true;
	}

	private function resync_provider_rating( int $provider_id ): void {
		global $wpdb;
		$stats = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM {$wpdb->prefix}bc_reviews WHERE target_type = 'provider' AND target_id = %d AND status = 'approved'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$provider_id
			),
			ARRAY_A
		);

		$provider_type = get_post_type( $provider_id ) ?: 'bc_professional';
		$this->indexer->update_rating( $provider_id, $provider_type, round( (float) ( $stats['avg_rating'] ?? 0 ), 2 ), (int) ( $stats['total'] ?? 0 ) );
	}

	private function format( array $row ): array {
		$author = get_userdata( (int) $row['author_id'] );
		return [
			'id'          => (int) $row['id'],
			'authorId'    => (int) $row['author_id'],
			'authorName'  => $author ? $author->display_name : '',
			'targetId'    => (int) $row['target_id'],
			'bookingId'   => (int) $row['booking_id'],
			'rating'      => (int) $row['rating'],
			'body'        => $row['body'],
			'status'      => $row['status'],
			'response'    => $row['response'],
			'responseAt'  => $row['response_at'],
			'createdAt'   => $row['created_at'],
		];
	}
}
