<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Phone;

/**
 * The one place in this codebase that turns whatever a user typed into a
 * canonical Iranian mobile number -- every other class in this plugin
 * (OtpService, AccountResolver, the phone-index table) only ever sees the
 * canonical form, never a raw one, so the same real number can never be
 * treated as two different accounts because of formatting alone.
 *
 * Canonical form: "+989XXXXXXXXX" -- +98, then 9, then nine more digits
 * (the real shape of every Iranian mobile number). Accepted inputs:
 * 09XXXXXXXXX, 989XXXXXXXXX, +989XXXXXXXXX, 00989XXXXXXXXX, each with
 * Persian or Arabic-Indic digits, optional spaces/dashes.
 */
final class PhoneNormalizer {

	private const PERSIAN = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];
	private const ARABIC  = [ '٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩' ];
	private const ASCII   = [ '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' ];

	/** Returns the canonical "+989XXXXXXXXX" form, or null if $raw is not a real Iranian mobile number. */
	public static function normalize( string $raw ): ?string {
		$s = str_replace( self::ARABIC, self::ASCII, str_replace( self::PERSIAN, self::ASCII, $raw ) );
		$s = preg_replace( '/[\s\-()]/', '', $s ) ?? '';

		if ( str_starts_with( $s, '+98' ) ) {
			$digits = substr( $s, 3 );
		} elseif ( str_starts_with( $s, '0098' ) ) {
			$digits = substr( $s, 4 );
		} elseif ( str_starts_with( $s, '98' ) && strlen( $s ) === 12 ) {
			$digits = substr( $s, 2 );
		} elseif ( str_starts_with( $s, '0' ) ) {
			$digits = substr( $s, 1 );
		} else {
			$digits = $s;
		}

		// A real Iranian mobile subscriber number: 9 followed by 9 more digits (10 digits total, always starts with 9).
		if ( ! preg_match( '/^9\d{9}$/', $digits ) ) {
			return null;
		}

		return '+98' . $digits;
	}

	/** True only for a value already in canonical form -- used to assert invariants, not to validate user input (use normalize() for that). */
	public static function is_canonical( string $value ): bool {
		return (bool) preg_match( '/^\+989\d{9}$/', $value );
	}

	/** A Persian, partially-masked form safe to echo back to a user ("۰۹۱۲***۴۵۶۷"), never the full number in a log or response that doesn't already require it. */
	public static function masked( string $canonical ): string {
		if ( ! self::is_canonical( $canonical ) ) {
			return '';
		}
		$local = '0' . substr( $canonical, 3 ); // +989121234567 -> 09121234567
		return substr( $local, 0, 4 ) . '***' . substr( $local, -4 );
	}
}
