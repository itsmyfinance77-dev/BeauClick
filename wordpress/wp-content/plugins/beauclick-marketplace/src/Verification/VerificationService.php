<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Verification;

use BeauClick\Marketplace\Search\Indexer;

/**
 * V2.1 Step 8 — the one place every verification status transition
 * happens. `_bc_verification_status` postmeta (V1-era) stays the single
 * source of truth every consumer (marketplace listing, MyProfileController,
 * Indexer -> wp_bc_provider_index.verified -> ranking) already reads;
 * this class is what makes changing it controlled, authorized, and
 * audited instead of a raw `update_post_meta()` call, and calls
 * Indexer::sync() on every real transition -- the exact same "resync the
 * search index whenever this changes" step VerificationMetaBox::save()
 * already did, now centralized here instead of duplicated at every call
 * site.
 *
 * Status values: unverified (default, no request ever submitted) | pending
 * | verified | rejected | suspended | revoked. `verified` is the only
 * value Indexer::sync() ever maps to `provider_index.verified = 1` --
 * unchanged, confirmed by reading that method's own existing
 * `'verified' === get_post_meta(...)` check, which needed no code change
 * for suspended/revoked to correctly stop counting as verified.
 */
final class VerificationService {

	public const STATUS_UNVERIFIED = 'unverified';
	public const STATUS_PENDING    = 'pending';
	public const STATUS_VERIFIED   = 'verified';
	public const STATUS_REJECTED   = 'rejected';
	public const STATUS_SUSPENDED  = 'suspended';
	public const STATUS_REVOKED    = 'revoked';

	/** @var array<string, string[]> */
	private const VALID_TRANSITIONS = [
		self::STATUS_UNVERIFIED => [ self::STATUS_PENDING ],
		self::STATUS_PENDING    => [ self::STATUS_VERIFIED, self::STATUS_REJECTED ],
		self::STATUS_REJECTED   => [ self::STATUS_PENDING ],
		self::STATUS_VERIFIED   => [ self::STATUS_SUSPENDED, self::STATUS_REVOKED ],
		self::STATUS_SUSPENDED  => [ self::STATUS_VERIFIED, self::STATUS_REVOKED ],
		self::STATUS_REVOKED    => [ self::STATUS_PENDING ],
	];

	private EvidenceStorage $storage;

	public function __construct( ?EvidenceStorage $storage = null ) {
		$this->storage = $storage ?? new EvidenceStorage();
	}

	public function current_status( int $provider_id ): string {
		return get_post_meta( $provider_id, '_bc_verification_status', true ) ?: self::STATUS_UNVERIFIED;
	}

	/** @return array<string, mixed> */
	public function summary( int $provider_id ): array {
		global $wpdb;
		$status = $this->current_status( $provider_id );

		$latest_request = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_verification_requests WHERE provider_id = %d ORDER BY id DESC LIMIT 1",
				$provider_id
			),
			ARRAY_A
		);

		$evidence = [];
		if ( $latest_request ) {
			$evidence = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT id, evidence_type, original_filename, mime_type, size_bytes, uploaded_at FROM {$wpdb->prefix}bc_verification_evidence WHERE request_id = %d ORDER BY id ASC",
					(int) $latest_request['id']
				),
				ARRAY_A
			);
		}

		$history = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT from_status, to_status, actor_user_id, reason, created_at FROM {$wpdb->prefix}bc_verification_history WHERE provider_id = %d ORDER BY id DESC LIMIT 20",
				$provider_id
			),
			ARRAY_A
		);

		return [
			'status'         => $status,
			'canSubmit'      => $this->can_transition( $status, self::STATUS_PENDING ),
			'latestRequest'  => $latest_request ? [
				'id'             => (int) $latest_request['id'],
				'status'         => $latest_request['status'],
				'submittedAt'    => $latest_request['submitted_at'],
				'decidedAt'      => $latest_request['decided_at'],
				'decisionReason' => $latest_request['decision_reason'],
			] : null,
			'evidence'       => array_map(
				static fn( array $e ) => [
					'id'               => (int) $e['id'],
					'evidenceType'     => $e['evidence_type'],
					'originalFilename' => $e['original_filename'],
					'mimeType'         => $e['mime_type'],
					'sizeBytes'        => (int) $e['size_bytes'],
					'uploadedAt'       => $e['uploaded_at'],
				],
				$evidence
			),
			'history'        => array_map(
				static fn( array $h ) => [
					'fromStatus' => $h['from_status'],
					'toStatus'   => $h['to_status'],
					'reason'     => $h['reason'],
					'createdAt'  => $h['created_at'],
				],
				$history
			),
		];
	}

	/**
	 * @param array<int, array{name:string,tmp_name:string,size:int,error:int,type:string}> $files One or more $_FILES-shaped entries.
	 * @param string[] $evidence_types Parallel array to $files.
	 * @return array{requestId:int}|\WP_Error
	 */
	public function submit_request( int $provider_id, int $submitted_by, array $files, array $evidence_types ) {
		$status = $this->current_status( $provider_id );
		if ( ! $this->can_transition( $status, self::STATUS_PENDING ) ) {
			return new \WP_Error( 'bc_invalid_transition', __( 'در وضعیت فعلی امکان ثبت درخواست جدید وجود ندارد.', 'beauclick-marketplace' ), [ 'status' => 409 ] );
		}
		if ( ! $files ) {
			return new \WP_Error( 'bc_evidence_required', __( 'برای ثبت درخواست، حداقل یک مدرک بارگذاری کنید.', 'beauclick-marketplace' ), [ 'status' => 422 ] );
		}

		global $wpdb;
		$now = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_verification_requests',
			[
				'provider_id'  => $provider_id,
				'status'       => self::STATUS_PENDING,
				'submitted_by' => $submitted_by,
				'submitted_at' => $now,
				'created_at'   => $now,
				'updated_at'   => $now,
			],
			[ '%d', '%s', '%d', '%s', '%s', '%s' ]
		);
		$request_id = (int) $wpdb->insert_id;

		foreach ( $files as $i => $file ) {
			$type   = $evidence_types[ $i ] ?? 'other';
			$stored = $this->storage->store( $file, $type );
			if ( is_wp_error( $stored ) ) {
				// Roll back whatever was already stored for this request
				// rather than leaving an inconsistent half-submitted
				// request row behind.
				$this->delete_request_evidence( $request_id );
				$wpdb->delete( $wpdb->prefix . 'bc_verification_requests', [ 'id' => $request_id ] );
				return $stored;
			}
			$wpdb->insert(
				$wpdb->prefix . 'bc_verification_evidence',
				[
					'request_id'        => $request_id,
					'evidence_type'     => $type,
					'storage_key'       => $stored['storageKey'],
					'original_filename' => sanitize_file_name( $file['name'] ?? 'file' ),
					'mime_type'         => $stored['mimeType'],
					'size_bytes'        => $stored['sizeBytes'],
					'uploaded_at'       => $now,
				],
				[ '%d', '%s', '%s', '%s', '%s', '%d', '%s' ]
			);
		}

		$this->transition( $provider_id, $status, self::STATUS_PENDING, $submitted_by, $request_id, null );

		return [ 'requestId' => $request_id ];
	}

	/**
	 * @param 'verified'|'rejected' $decision
	 */
	public function decide( int $request_id, int $reviewer_id, string $decision, string $reason ): bool|\WP_Error {
		if ( ! in_array( $decision, [ self::STATUS_VERIFIED, self::STATUS_REJECTED ], true ) ) {
			return new \WP_Error( 'bc_invalid_decision', __( 'تصمیم نامعتبر است.', 'beauclick-marketplace' ), [ 'status' => 422 ] );
		}

		global $wpdb;
		$request = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_verification_requests WHERE id = %d", $request_id ), ARRAY_A );
		if ( ! $request || self::STATUS_PENDING !== $request['status'] ) {
			return new \WP_Error( 'bc_not_found', __( 'این درخواست پیدا نشد یا قبلاً بررسی شده است.', 'beauclick-marketplace' ), [ 'status' => 404 ] );
		}

		$provider_id     = (int) $request['provider_id'];
		$current_status  = $this->current_status( $provider_id );
		if ( ! $this->can_transition( $current_status, $decision ) ) {
			return new \WP_Error( 'bc_invalid_transition', __( 'در وضعیت فعلی این تصمیم قابل ثبت نیست.', 'beauclick-marketplace' ), [ 'status' => 409 ] );
		}

		$now = current_time( 'mysql' );
		$wpdb->update(
			$wpdb->prefix . 'bc_verification_requests',
			[ 'status' => $decision, 'decided_by' => $reviewer_id, 'decided_at' => $now, 'decision_reason' => $reason ?: null, 'updated_at' => $now ],
			[ 'id' => $request_id ]
		);

		$this->transition( $provider_id, $current_status, $decision, $reviewer_id, $request_id, $reason ?: null );

		return true;
	}

	public function suspend( int $provider_id, int $actor_id, string $reason ): bool|\WP_Error {
		return $this->admin_transition( $provider_id, self::STATUS_SUSPENDED, $actor_id, $reason );
	}

	public function revoke( int $provider_id, int $actor_id, string $reason ): bool|\WP_Error {
		return $this->admin_transition( $provider_id, self::STATUS_REVOKED, $actor_id, $reason );
	}

	public function reinstate( int $provider_id, int $actor_id, string $reason ): bool|\WP_Error {
		return $this->admin_transition( $provider_id, self::STATUS_VERIFIED, $actor_id, $reason );
	}

	private function admin_transition( int $provider_id, string $to, int $actor_id, string $reason ): bool|\WP_Error {
		$current = $this->current_status( $provider_id );
		if ( ! $this->can_transition( $current, $to ) ) {
			return new \WP_Error( 'bc_invalid_transition', __( 'این تغییر وضعیت در حال حاضر مجاز نیست.', 'beauclick-marketplace' ), [ 'status' => 409 ] );
		}
		$this->transition( $provider_id, $current, $to, $actor_id, null, $reason ?: null );
		return true;
	}

	public function can_transition( string $from, string $to ): bool {
		return in_array( $to, self::VALID_TRANSITIONS[ $from ] ?? [], true );
	}

	private function transition( int $provider_id, string $from, string $to, int $actor_id, ?int $request_id, ?string $reason ): void {
		global $wpdb;

		update_post_meta( $provider_id, '_bc_verification_status', $to );

		$wpdb->insert(
			$wpdb->prefix . 'bc_verification_history',
			[
				'provider_id'   => $provider_id,
				'request_id'    => $request_id,
				'from_status'   => $from,
				'to_status'     => $to,
				'actor_user_id' => $actor_id,
				'reason'        => $reason,
				'created_at'    => current_time( 'mysql' ),
			],
			[ '%d', '%d', '%s', '%s', '%d', '%s', '%s' ]
		);

		$post = get_post( $provider_id );
		if ( $post ) {
			( new Indexer() )->sync( $provider_id, $post->post_type );
		}
	}

	private function delete_request_evidence( int $request_id ): void {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT storage_key FROM {$wpdb->prefix}bc_verification_evidence WHERE request_id = %d", $request_id ), ARRAY_A );
		foreach ( $rows as $row ) {
			$this->storage->delete( $row['storage_key'] );
		}
		$wpdb->delete( $wpdb->prefix . 'bc_verification_evidence', [ 'request_id' => $request_id ] );
	}

	public function evidence_storage_key( int $evidence_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT e.storage_key, e.mime_type, e.original_filename, r.provider_id
				FROM {$wpdb->prefix}bc_verification_evidence e
				JOIN {$wpdb->prefix}bc_verification_requests r ON r.id = e.request_id
				WHERE e.id = %d",
				$evidence_id
			),
			ARRAY_A
		);
		return $row ?: null;
	}

	public function storage(): EvidenceStorage {
		return $this->storage;
	}
}
