<?php
declare( strict_types=1 );

/**
 * EvidenceStorage::store() deliberately calls is_uploaded_file()/
 * move_uploaded_file() to guard against a crafted $_FILES-shaped array
 * pointing at an arbitrary local path -- a real security check, not
 * incidental. Outside a genuine PHP-handled multipart upload (i.e. every
 * test in this suite), those two builtins always return false, which would
 * make it impossible to exercise store() at all.
 *
 * PHP resolves an unqualified function call first against the CURRENT
 * namespace, falling back to the global function only if no namespaced
 * version exists (resolved per-call, at runtime, against whatever has been
 * declared by that point in the process) -- so declaring
 * BeauClick\Marketplace\Verification\is_uploaded_file() here, once, lets
 * every test relax that specific check to "the file really exists" while
 * every other file-system operation in EvidenceStorage runs unmodified.
 * Production code (EvidenceStorage.php itself) is untouched; this file is
 * never loaded outside PHPUnit.
 */
namespace BeauClick\Marketplace\Verification {
	function is_uploaded_file( string $filename ): bool {
		return file_exists( $filename );
	}

	function move_uploaded_file( string $from, string $to ): bool {
		// copy()+unlink() rather than rename() -- the real
		// move_uploaded_file() works across filesystem boundaries (PHP's
		// temp dir vs. wp-content/uploads may not be on the same volume),
		// and rename() can fail there where a copy always succeeds.
		return copy( $from, $to ) && unlink( $from );
	}
}
