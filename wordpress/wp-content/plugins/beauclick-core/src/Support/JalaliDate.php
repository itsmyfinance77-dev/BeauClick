<?php
declare( strict_types=1 );

namespace BeauClick\Core\Support;

/**
 * Gregorian <-> Jalali (Solar Hijri) calendar conversion and Persian date
 * formatting — the ONE server-side implementation every plugin should use
 * for a date a real person (customer/professional/business) will see
 * (transactional emails, server-rendered theme templates), rather than
 * each plugin/template hand-rolling its own conversion. Lives in
 * beauclick-core because every other plugin already depends on it, the
 * same "shared abstraction in the base layer" reasoning already applied to
 * EventLogger/Migrator.
 *
 * Deliberately the exact same algorithm as the frontend's
 * app/src/lib/jalali.ts (the standard, widely-used 2820-year-cycle Jalali
 * calculation routed through Julian Day Numbers) — PHP and TypeScript
 * can't literally share one source file, so the two are kept in sync by
 * hand and verified independently against the same golden reference point
 * (1979-02-11 Gregorian <-> 1357-11-22 Jalali, Iranian Revolution Day) in
 * each side's own test suite. If one is ever changed, the other must be
 * updated identically.
 *
 * This class only converts calendar *dates* (year/month/day integers) —
 * it never guesses a timezone. Callers pass in the already-correct
 * site-local Gregorian y/m/d (e.g. from current_time('mysql')-formatted
 * strings, which are already WordPress's own configured site timezone,
 * never raw UTC) — this is what avoids an off-by-one-day error at
 * midnight boundaries that a naive UTC-based conversion would introduce.
 */
final class JalaliDate {

	/** Years marking the boundaries of the 33-year sub-cycles within the 2820-year grand cycle. */
	private const BREAKS = [ -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178 ];

	public const MONTHS = [
		1  => 'فروردین',
		2  => 'اردیبهشت',
		3  => 'خرداد',
		4  => 'تیر',
		5  => 'مرداد',
		6  => 'شهریور',
		7  => 'مهر',
		8  => 'آبان',
		9  => 'آذر',
		10 => 'دی',
		11 => 'بهمن',
		12 => 'اسفند',
	];

	private const PERSIAN_DIGITS = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];

	/** @return array{jy:int,jm:int,jd:int} */
	public static function toJalali( int $gy, int $gm, int $gd ): array {
		return self::d2j( self::g2d( $gy, $gm, $gd ) );
	}

	/** @return array{gy:int,gm:int,gd:int} */
	public static function toGregorian( int $jy, int $jm, int $jd ): array {
		return self::d2g( self::j2d( $jy, $jm, $jd ) );
	}

	public static function isLeapYear( int $jy ): bool {
		return self::jalCal( $jy )['leap'] === 0;
	}

	/**
	 * Formats a MySQL/site-local datetime string (e.g. from
	 * current_time('mysql') or a wp_bc_* table column, both already
	 * site-local wall-clock values with no timezone marker of their own)
	 * as a Persian Jalali date, optionally with time.
	 *
	 * Deliberately parses the y/m/d/H/i components directly out of the
	 * string with a regex rather than routing through strtotime()+gmdate()
	 * — that round trip would reinterpret the naive datetime through
	 * PHP's/WordPress's configured timezone and back out as UTC, silently
	 * shifting the calendar date near midnight whenever the site timezone
	 * isn't UTC+00:00. Reading the digits straight out of the string is
	 * the only way to guarantee the exact wall-clock date the caller
	 * already resolved is the one that gets converted — the same
	 * off-by-one-day failure mode this task explicitly calls out.
	 *
	 * Falls back to the raw string if it doesn't look like a datetime,
	 * matching this codebase's existing "never fatal on a formatting
	 * helper" convention (see beauclick-booking's own prior
	 * format_when()).
	 */
	public static function format( string $datetime, bool $includeTime = false ): string {
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/', $datetime, $m ) ) {
			return $datetime;
		}

		$j = self::toJalali( (int) $m[1], (int) $m[2], (int) $m[3] );

		$out = self::persianDigits( (string) $j['jd'] ) . ' ' . self::MONTHS[ $j['jm'] ] . ' ' . self::persianDigits( (string) $j['jy'] );

		if ( $includeTime && isset( $m[4], $m[5] ) ) {
			$out .= ' - ' . self::persianDigits( $m[4] . ':' . $m[5] );
		}

		return $out;
	}

	public static function persianDigits( string $input ): string {
		return strtr( $input, [ '0' => self::PERSIAN_DIGITS[0], '1' => self::PERSIAN_DIGITS[1], '2' => self::PERSIAN_DIGITS[2], '3' => self::PERSIAN_DIGITS[3], '4' => self::PERSIAN_DIGITS[4], '5' => self::PERSIAN_DIGITS[5], '6' => self::PERSIAN_DIGITS[6], '7' => self::PERSIAN_DIGITS[7], '8' => self::PERSIAN_DIGITS[8], '9' => self::PERSIAN_DIGITS[9] ] );
	}

	private static function div( int $a, int $b ): int {
		return intdiv( $a, $b );
	}

	private static function mod( int $a, int $b ): int {
		return $a - intdiv( $a, $b ) * $b;
	}

	/** @return array{leap:int,gy:int,march:int} */
	private static function jalCal( int $jy ): array {
		$bl    = count( self::BREAKS );
		$gy    = $jy + 621;
		$leapJ = -14;
		$jp    = self::BREAKS[0];
		$jump  = 0;

		for ( $i = 1; $i < $bl; $i++ ) {
			$jm   = self::BREAKS[ $i ];
			$jump = $jm - $jp;
			if ( $jy < $jm ) {
				break;
			}
			$leapJ = $leapJ + self::div( $jump, 33 ) * 8 + self::div( self::mod( $jump, 33 ), 4 );
			$jp    = $jm;
		}

		$n     = $jy - $jp;
		$leapJ = $leapJ + self::div( $n, 33 ) * 8 + self::div( self::mod( $n, 33 ) + 3, 4 );
		if ( self::mod( $jump, 33 ) === 4 && $jump - $n === 4 ) {
			++$leapJ;
		}

		$leapG = self::div( $gy, 4 ) - self::div( ( self::div( $gy, 100 ) + 1 ) * 3, 4 ) - 150;
		$march = 20 + $leapJ - $leapG;

		if ( $jump - $n < 6 ) {
			$n = $n - $jump + self::div( $jump + 4, 33 ) * 33;
		}
		$leap = self::mod( self::mod( $n + 1, 33 ) - 1, 4 );
		if ( -1 === $leap ) {
			$leap = 4;
		}

		return [ 'leap' => $leap, 'gy' => $gy, 'march' => $march ];
	}

	private static function g2d( int $gy, int $gm, int $gd ): int {
		$d = self::div( ( $gy + self::div( $gm - 8, 6 ) + 100100 ) * 1461, 4 ) + self::div( 153 * self::mod( $gm + 9, 12 ) + 2, 5 ) + $gd - 34840408;
		$d = $d - self::div( self::div( $gy + 100100 + self::div( $gm - 8, 6 ), 100 ) * 3, 4 ) + 752;
		return $d;
	}

	/** @return array{gy:int,gm:int,gd:int} */
	private static function d2g( int $jdn ): array {
		$j  = 4 * $jdn + 139361631;
		$j  = $j + self::div( self::div( 4 * $jdn + 183187720, 146097 ) * 3, 4 ) * 4 - 3908;
		$i  = self::div( self::mod( $j, 1461 ), 4 ) * 5 + 308;
		$gd = self::div( self::mod( $i, 153 ), 5 ) + 1;
		$gm = self::mod( self::div( $i, 153 ), 12 ) + 1;
		$gy = self::div( $j, 1461 ) - 100100 + self::div( 8 - $gm, 6 );
		return [ 'gy' => $gy, 'gm' => $gm, 'gd' => $gd ];
	}

	private static function j2d( int $jy, int $jm, int $jd ): int {
		$r = self::jalCal( $jy );
		return self::g2d( $r['gy'], 3, $r['march'] ) + ( $jm - 1 ) * 31 - self::div( $jm, 7 ) * ( $jm - 7 ) + $jd - 1;
	}

	/** @return array{jy:int,jm:int,jd:int} */
	private static function d2j( int $jdn ): array {
		$gy = self::d2g( $jdn )['gy'];
		$jy = $gy - 621;
		$r  = self::jalCal( $jy );

		$jdn1f = self::g2d( $r['gy'], 3, $r['march'] );
		$k     = $jdn - $jdn1f;

		if ( $k >= 0 ) {
			if ( $k <= 185 ) {
				return [ 'jy' => $jy, 'jm' => 1 + self::div( $k, 31 ), 'jd' => self::mod( $k, 31 ) + 1 ];
			}
			$k -= 186;
		} else {
			--$jy;
			$k += 179;
			if ( 1 === $r['leap'] ) {
				++$k;
			}
		}

		return [ 'jy' => $jy, 'jm' => 7 + self::div( $k, 30 ), 'jd' => self::mod( $k, 30 ) + 1 ];
	}
}
