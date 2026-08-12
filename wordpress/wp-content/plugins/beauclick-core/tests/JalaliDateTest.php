<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Support\JalaliDate;
use WP_UnitTestCase;

final class JalaliDateTest extends WP_UnitTestCase {

	public function test_matches_the_well_known_golden_reference_point(): void {
		// Iranian Revolution Day -- a widely-known, independently verifiable
		// fixed point, not derived from this class's own logic.
		$this->assertSame( [ 'jy' => 1357, 'jm' => 11, 'jd' => 22 ], JalaliDate::toJalali( 1979, 2, 11 ) );
		$this->assertSame( [ 'gy' => 1979, 'gm' => 2, 'gd' => 11 ], JalaliDate::toGregorian( 1357, 11, 22 ) );
	}

	public function test_places_nowruz_1403_on_2024_03_20(): void {
		$this->assertSame( [ 'jy' => 1403, 'jm' => 1, 'jd' => 1 ], JalaliDate::toJalali( 2024, 3, 20 ) );
		$this->assertSame( [ 'gy' => 2024, 'gm' => 3, 'gd' => 20 ], JalaliDate::toGregorian( 1403, 1, 1 ) );
	}

	public function test_the_day_before_nowruz_is_the_last_day_of_the_previous_jalali_year(): void {
		$result = JalaliDate::toJalali( 2024, 3, 19 );
		$this->assertSame( 1402, $result['jy'] );
		$this->assertSame( 12, $result['jm'] );
	}

	public function test_round_trips_a_wide_multi_decade_date_range_with_zero_mismatches(): void {
		$failures = 0;
		for ( $y = 1970; $y < 2035; $y++ ) {
			for ( $m = 1; $m <= 12; $m++ ) {
				for ( $d = 1; $d <= 28; $d++ ) {
					$j    = JalaliDate::toJalali( $y, $m, $d );
					$back = JalaliDate::toGregorian( $j['jy'], $j['jm'], $j['jd'] );
					if ( $back['gy'] !== $y || $back['gm'] !== $m || $back['gd'] !== $d ) {
						++$failures;
					}
				}
			}
		}
		$this->assertSame( 0, $failures );
	}

	public function test_1403_is_a_leap_year_with_a_30_day_esfand(): void {
		$this->assertTrue( JalaliDate::isLeapYear( 1403 ) );
	}

	public function test_1402_is_not_a_leap_year(): void {
		$this->assertFalse( JalaliDate::isLeapYear( 1402 ) );
	}

	public function test_format_converts_a_site_local_datetime_to_a_persian_jalali_string(): void {
		$this->assertSame( '۱ فروردین ۱۴۰۳', JalaliDate::format( '2024-03-20 00:00:00' ) );
	}

	public function test_format_includes_time_when_requested(): void {
		$result = JalaliDate::format( '2024-03-20 14:30:00', true );
		$this->assertStringContainsString( '۱۴:۳۰', $result );
		$this->assertStringContainsString( '۱ فروردین ۱۴۰۳', $result );
	}

	public function test_format_never_round_trips_through_a_timezone_conversion(): void {
		// Regression guard for the exact bug class this task calls out: an
		// earlier version of this method used strtotime()+gmdate(), which
		// re-interprets a naive site-local datetime string through PHP's
		// configured timezone and back out as UTC -- shifting the calendar
		// date near midnight whenever the site timezone isn't UTC+00:00
		// (this platform is Asia/Tehran, UTC+03:30 -- see TimezoneTest).
		// Parsing the digits directly out of the string sidesteps that
		// entirely; this asserts a near-midnight datetime keeps its own
		// literal date, not a shifted one.
		$this->assertSame( '۱ فروردین ۱۴۰۳', JalaliDate::format( '2024-03-20 23:59:00' ) );
	}

	public function test_format_falls_back_to_the_raw_string_for_unparseable_input(): void {
		$this->assertSame( 'not-a-date', JalaliDate::format( 'not-a-date' ) );
	}

	public function test_persian_digits_swaps_ascii_digits_only(): void {
		$this->assertSame( '۱۴۰۳', JalaliDate::persianDigits( '1403' ) );
	}

	public function test_month_names_cover_all_twelve_months(): void {
		$this->assertCount( 12, JalaliDate::MONTHS );
		$this->assertSame( 'فروردین', JalaliDate::MONTHS[1] );
		$this->assertSame( 'اسفند', JalaliDate::MONTHS[12] );
	}
}
