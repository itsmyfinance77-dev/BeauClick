<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Verification;

/**
 * Verification evidence (a professional's identity/certificate/license
 * documents) is genuinely sensitive — the task's own explicit instruction
 * is that the normal WordPress Media Library (predictable `/wp-content/
 * uploads/2026/08/file.jpg` public URLs, indexed, hotlinkable, no
 * per-request authorization) is NOT appropriate here, unlike the
 * professional profile *image* (already correctly using Media Library —
 * a deliberately public asset with nothing sensitive about it).
 *
 * The real security boundary is NOT the filesystem location — it's that
 * a stored file's path/storage_key is never placed in any public HTML,
 * REST response field a stranger could reach, or predictable URL; the
 * only code path that ever reads a file back is
 * VerificationController::download_evidence(), which re-checks ownership/
 * capability on every single request before streaming a byte. The
 * directory-level protections below (index.php, .htaccess) are real
 * defense-in-depth for Apache/Nginx-with-equivalent-config production
 * hosting, but are honestly not enforced by this project's own PHP
 * built-in dev server — documented here rather than silently assumed.
 */
final class EvidenceStorage {

	private const SUBDIR = 'bc-verification-evidence';

	/** @var array<string, string[]> evidence category => allowed real (content-sniffed) MIME types */
	private const ALLOWED_MIME_TO_EXT = [
		'image/jpeg'      => 'jpg',
		'image/png'       => 'png',
		'image/webp'      => 'webp',
		'application/pdf' => 'pdf',
	];

	private const MAX_BYTES = 8 * 1024 * 1024; // 8MB — enough for a real photo/scan, not a video.

	private const EVIDENCE_TYPES = [ 'identity', 'certificate', 'license', 'portfolio', 'other' ];

	/** @return string[] */
	public static function evidence_types(): array {
		return self::EVIDENCE_TYPES;
	}

	private function base_dir(): string {
		$upload_dir = wp_upload_dir();
		return trailingslashit( $upload_dir['basedir'] ) . self::SUBDIR;
	}

	/**
	 * Idempotent — safe to call on every upload, matching the same
	 * "ensure, don't assume" discipline used elsewhere in this codebase.
	 * Same convention WordPress's own wp-content/uploads/.htaccess-less
	 * default relies on an index.php for: no directory listing even
	 * without a working .htaccess.
	 */
	private function ensure_protected_dir(): string {
		$dir = $this->base_dir();
		if ( ! file_exists( $dir ) ) {
			wp_mkdir_p( $dir );
		}
		$index = $dir . '/index.php';
		if ( ! file_exists( $index ) ) {
			file_put_contents( $index, "<?php\n// Silence is golden.\n" );
		}
		$htaccess = $dir . '/.htaccess';
		if ( ! file_exists( $htaccess ) ) {
			file_put_contents( $htaccess, "Require all denied\nDeny from all\n" );
		}
		return $dir;
	}

	/**
	 * @param array{name:string,tmp_name:string,size:int,error:int} $file One entry of $_FILES.
	 * @return array{storageKey:string,mimeType:string,sizeBytes:int}|\WP_Error
	 */
	public function store( array $file, string $evidence_type ) {
		if ( ! in_array( $evidence_type, self::EVIDENCE_TYPES, true ) ) {
			return new \WP_Error( 'bc_invalid_evidence_type', __( 'نوع مدرک نامعتبر است.', 'beauclick-marketplace' ) );
		}
		if ( ( $file['error'] ?? UPLOAD_ERR_NO_FILE ) !== UPLOAD_ERR_OK ) {
			return new \WP_Error( 'bc_upload_failed', __( 'بارگذاری فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'beauclick-marketplace' ) );
		}
		if ( ( (int) ( $file['size'] ?? 0 ) ) > self::MAX_BYTES ) {
			return new \WP_Error( 'bc_file_too_large', __( 'حجم فایل نباید بیشتر از ۸ مگابایت باشد.', 'beauclick-marketplace' ) );
		}
		if ( ! is_uploaded_file( $file['tmp_name'] ?? '' ) ) {
			// Never trust that a request genuinely came from a real file
			// upload -- this is PHP's own guard against a crafted
			// $_FILES-shaped array pointing at an arbitrary local path.
			return new \WP_Error( 'bc_upload_failed', __( 'بارگذاری فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'beauclick-marketplace' ) );
		}

		// Real, content-sniffed MIME detection -- never the client-supplied
		// $file['type'] (trivially spoofable) and never a bare extension
		// check (a renamed .php can claim any extension it likes).
		$finfo     = finfo_open( FILEINFO_MIME_TYPE );
		$real_mime = finfo_file( $finfo, $file['tmp_name'] );
		// No finfo_close() -- PHP 8.5 frees finfo resources automatically and
		// deprecates the explicit call.

		if ( ! isset( self::ALLOWED_MIME_TO_EXT[ $real_mime ] ) ) {
			return new \WP_Error( 'bc_invalid_file_type', __( 'فقط فایل تصویری (jpg, png, webp) یا PDF قابل قبول است.', 'beauclick-marketplace' ) );
		}

		$dir         = $this->ensure_protected_dir();
		$storage_key = bin2hex( random_bytes( 24 ) ) . '.' . self::ALLOWED_MIME_TO_EXT[ $real_mime ]; // Never derived from the original filename -- a randomized name is the whole point.
		$destination = $dir . '/' . $storage_key;

		if ( ! move_uploaded_file( $file['tmp_name'], $destination ) ) {
			return new \WP_Error( 'bc_upload_failed', __( 'ذخیره‌سازی فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'beauclick-marketplace' ) );
		}

		return [
			'storageKey' => $storage_key,
			'mimeType'   => $real_mime,
			'sizeBytes'  => (int) filesize( $destination ),
		];
	}

	public function path_for( string $storage_key ): string {
		return $this->base_dir() . '/' . $storage_key;
	}

	public function delete( string $storage_key ): void {
		$path = $this->path_for( $storage_key );
		if ( file_exists( $path ) ) {
			wp_delete_file( $path );
		}
	}
}
