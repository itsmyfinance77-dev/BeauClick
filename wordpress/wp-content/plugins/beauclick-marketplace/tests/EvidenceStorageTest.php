<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

require_once __DIR__ . '/support/upload-test-overrides.php';

use BeauClick\Marketplace\Verification\EvidenceStorage;
use WP_UnitTestCase;

/**
 * File-upload security scenarios required by V2.1 Step 8: real
 * content-sniffed MIME validation (never the client-supplied type or a bare
 * extension), oversized-file rejection, invalid-evidence-type rejection,
 * and randomized (never predictable/derived) storage filenames. See
 * tests/support/upload-test-overrides.php for why is_uploaded_file()/
 * move_uploaded_file() need a namespaced override to be testable at all.
 */
final class EvidenceStorageTest extends WP_UnitTestCase {

	// A minimal but real, correctly-signatured 1x1 PNG -- libmagic identifies
	// it as image/png from these bytes alone, verified against this
	// environment's actual finfo build before writing this test.
	private const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

	private const VALID_PDF_BYTES = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF";

	private function make_temp_file( string $contents ): string {
		$path = tempnam( sys_get_temp_dir(), 'bc-evidence-test-' );
		file_put_contents( $path, $contents );
		return $path;
	}

	/** @return array{name:string,tmp_name:string,size:int,error:int,type:string} */
	private function fake_upload( string $contents, string $claimed_name = 'file.jpg', string $claimed_type = 'image/jpeg' ): array {
		$path = $this->make_temp_file( $contents );
		return [
			'name'     => $claimed_name,
			'tmp_name' => $path,
			'size'     => strlen( $contents ),
			'error'    => UPLOAD_ERR_OK,
			'type'     => $claimed_type,
		];
	}

	public function test_a_genuinely_valid_png_is_stored(): void {
		$file = $this->fake_upload( base64_decode( self::VALID_PNG_BASE64 ), 'photo.png', 'image/png' );

		$result = ( new EvidenceStorage() )->store( $file, 'identity' );

		$this->assertIsArray( $result );
		$this->assertSame( 'image/png', $result['mimeType'] );
		$this->assertFileExists( ( new EvidenceStorage() )->path_for( $result['storageKey'] ) );
	}

	public function test_a_genuinely_valid_pdf_is_stored(): void {
		$file = $this->fake_upload( self::VALID_PDF_BYTES, 'license.pdf', 'application/pdf' );

		$result = ( new EvidenceStorage() )->store( $file, 'license' );

		$this->assertIsArray( $result );
		$this->assertSame( 'application/pdf', $result['mimeType'] );
	}

	public function test_the_stored_filename_is_never_derived_from_the_original_filename(): void {
		$file = $this->fake_upload( base64_decode( self::VALID_PNG_BASE64 ), 'my-national-id-card.png', 'image/png' );

		$result = ( new EvidenceStorage() )->store( $file, 'identity' );

		$this->assertIsArray( $result );
		$this->assertStringNotContainsString( 'my-national-id-card', $result['storageKey'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{48}\.png$/', $result['storageKey'] );
	}

	public function test_a_file_claiming_to_be_a_jpeg_but_actually_php_source_is_rejected(): void {
		// The client-supplied `type` field lies (claims image/jpeg); the
		// actual bytes are PHP source. Real content-sniffing must catch
		// this even though a naive extension/MIME-header check would not.
		$file = $this->fake_upload( "<?php echo 'this is php source, not an image'; ?>", 'totally-a-photo.jpg', 'image/jpeg' );

		$result = ( new EvidenceStorage() )->store( $file, 'identity' );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_invalid_file_type', $result->get_error_code() );
	}

	public function test_a_plain_text_file_is_rejected(): void {
		$file = $this->fake_upload( 'just some plain text, nothing special here at all.', 'notes.txt', 'text/plain' );

		$result = ( new EvidenceStorage() )->store( $file, 'other' );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_invalid_file_type', $result->get_error_code() );
	}

	public function test_an_oversized_file_is_rejected(): void {
		$file = $this->fake_upload( base64_decode( self::VALID_PNG_BASE64 ), 'photo.png', 'image/png' );
		$file['size'] = 9 * 1024 * 1024; // Reported size only -- store() must reject on the declared size before ever touching file content.

		$result = ( new EvidenceStorage() )->store( $file, 'identity' );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_file_too_large', $result->get_error_code() );
	}

	public function test_an_invalid_evidence_type_is_rejected(): void {
		$file = $this->fake_upload( base64_decode( self::VALID_PNG_BASE64 ), 'photo.png', 'image/png' );

		$result = ( new EvidenceStorage() )->store( $file, 'passport_and_bank_statement' );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_invalid_evidence_type', $result->get_error_code() );
	}

	public function test_a_failed_upload_error_code_is_rejected(): void {
		$file = $this->fake_upload( base64_decode( self::VALID_PNG_BASE64 ), 'photo.png', 'image/png' );
		$file['error'] = UPLOAD_ERR_PARTIAL;

		$result = ( new EvidenceStorage() )->store( $file, 'identity' );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_upload_failed', $result->get_error_code() );
	}
}
