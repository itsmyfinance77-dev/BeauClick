<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Export;

/**
 * A generated data-export ZIP is genuinely sensitive (it's the customer's
 * own complete personal-data bundle) — stored the exact same way
 * beauclick-marketplace's `EvidenceStorage` (V2.1 Step 8) already stores
 * verification evidence: outside any public/predictable URL, with
 * defense-in-depth `index.php`/`.htaccess` protection, a randomized
 * filename never derived from anything guessable, and the real security
 * boundary living in the one REST handler that streams it back
 * (`PrivacyController::download_export()`), which re-checks ownership and
 * the request's own token/expiry on every call.
 */
final class ExportStorage {

	private const SUBDIR = 'bc-data-exports';

	private function base_dir(): string {
		$upload_dir = wp_upload_dir();
		return trailingslashit( $upload_dir['basedir'] ) . self::SUBDIR;
	}

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

	/** @return string The random storage filename (never derived from anything about the user) — store this, not the path, on the request row. */
	public function reserve_filename(): string {
		$this->ensure_protected_dir();
		return bin2hex( random_bytes( 24 ) ) . '.zip';
	}

	public function path_for( string $filename ): string {
		return $this->base_dir() . '/' . $filename;
	}

	public function delete( string $filename ): void {
		$path = $this->path_for( $filename );
		if ( file_exists( $path ) ) {
			wp_delete_file( $path );
		}
	}
}
