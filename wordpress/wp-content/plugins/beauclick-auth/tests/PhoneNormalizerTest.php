<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Tests;

use BeauClick\Auth\Phone\PhoneNormalizer;
use WP_UnitTestCase;

final class PhoneNormalizerTest extends WP_UnitTestCase {

	public function test_local_09_format_normalizes_correctly(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '09121234567' ) );
	}

	public function test_e164_format_is_accepted_as_is(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '+989121234567' ) );
	}

	public function test_00_international_prefix_normalizes_correctly(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '00989121234567' ) );
	}

	public function test_bare_98_prefix_without_plus_normalizes_correctly(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '989121234567' ) );
	}

	public function test_persian_digit_input_normalizes_the_same_as_ascii(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '۰۹۱۲۱۲۳۴۵۶۷' ) );
	}

	public function test_arabic_indic_digit_input_normalizes_the_same_as_ascii(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '٠٩١٢١٢٣٤٥٦٧' ) );
	}

	public function test_spaces_and_dashes_are_tolerated(): void {
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '0912-123-4567' ) );
		$this->assertSame( '+989121234567', PhoneNormalizer::normalize( '0912 123 4567' ) );
	}

	public function test_every_valid_format_produces_the_identical_canonical_value(): void {
		$forms = [ '09121234567', '+989121234567', '00989121234567', '989121234567', '۰۹۱۲۱۲۳۴۵۶۷' ];
		$canonical = array_map( fn( $f ) => PhoneNormalizer::normalize( $f ), $forms );
		$this->assertCount( 1, array_unique( $canonical ), 'Every real-world format of the same number must normalize to one identical canonical value, or duplicate accounts become possible.' );
	}

	public function test_a_landline_number_is_rejected(): void {
		$this->assertNull( PhoneNormalizer::normalize( '02112345678' ) );
	}

	public function test_too_short_input_is_rejected(): void {
		$this->assertNull( PhoneNormalizer::normalize( '0912123' ) );
	}

	public function test_too_long_input_is_rejected(): void {
		$this->assertNull( PhoneNormalizer::normalize( '091212345678' ) );
	}

	public function test_non_numeric_input_is_rejected(): void {
		$this->assertNull( PhoneNormalizer::normalize( 'not-a-phone' ) );
	}

	public function test_empty_input_is_rejected(): void {
		$this->assertNull( PhoneNormalizer::normalize( '' ) );
	}

	public function test_masked_returns_a_partially_hidden_persian_style_local_number(): void {
		$masked = PhoneNormalizer::masked( '+989121234567' );
		$this->assertSame( '0912***4567', $masked );
	}

	public function test_masked_returns_empty_string_for_a_non_canonical_input(): void {
		$this->assertSame( '', PhoneNormalizer::masked( '09121234567' ) );
	}

	public function test_is_canonical(): void {
		$this->assertTrue( PhoneNormalizer::is_canonical( '+989121234567' ) );
		$this->assertFalse( PhoneNormalizer::is_canonical( '09121234567' ) );
	}
}
