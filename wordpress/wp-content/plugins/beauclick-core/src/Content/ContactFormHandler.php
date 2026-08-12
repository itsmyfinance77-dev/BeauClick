<?php
declare( strict_types=1 );

namespace BeauClick\Core\Content;

/**
 * A plain `admin-post.php` form handler, not a REST endpoint + React mount
 * — the contact form has no reason to be a client-rendered island (task's
 * own "do not build an overly complex spam system... use a reasonable
 * local architecture"). Delivers to the site's own real `admin_email`
 * option (a value that genuinely already exists), never a fabricated
 * support address.
 *
 * `process()` is the actual logic (validation, honeypot, rate limit,
 * sending) and returns a plain status string with no I/O side effects
 * beyond the mail itself — `handle()`, the real `admin_post_*` hook
 * target, is a thin wrapper that turns that status into a redirect+exit.
 * Split this way specifically so the logic is unit-testable without
 * needing to intercept a real `exit()` call.
 */
final class ContactFormHandler {

	private const ACTION            = 'bc_contact_submit';
	private const NONCE_ACTION      = 'bc_contact_form';
	private const RATE_LIMIT_MAX    = 5;
	private const RATE_LIMIT_WINDOW = HOUR_IN_SECONDS;

	public static function register(): void {
		add_action( 'admin_post_' . self::ACTION, [ self::class, 'handle' ] );
		add_action( 'admin_post_nopriv_' . self::ACTION, [ self::class, 'handle' ] );
	}

	public static function nonce_field(): string {
		return wp_nonce_field( self::NONCE_ACTION, '_bc_contact_nonce', true, false );
	}

	public static function action(): string {
		return self::ACTION;
	}

	public static function handle(): void {
		$redirect = wp_get_referer() ?: home_url( '/contact/' );
		$status   = self::process( wp_unslash( $_POST ), sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified inside process()

		wp_safe_redirect( add_query_arg( 'bc_contact', $status, $redirect ) );
		exit;
	}

	/**
	 * @param array<string, mixed> $post
	 * @return 'sent'|'invalid'|'rate_limited'
	 */
	public static function process( array $post, string $remote_addr ): string {
		if ( ! isset( $post['_bc_contact_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( (string) $post['_bc_contact_nonce'] ), self::NONCE_ACTION ) ) {
			return 'invalid';
		}

		// Honeypot: a real visitor never fills a field named to look
		// technical and hidden via CSS (page-contact.php renders it
		// off-screen, not display:none, since some bots skip
		// display:none fields specifically). Pretend success -- never tell
		// a bot its submission was rejected.
		if ( ! empty( $post['bc_website'] ?? '' ) ) {
			return 'sent';
		}

		$name    = sanitize_text_field( (string) ( $post['name'] ?? '' ) );
		$email   = sanitize_email( (string) ( $post['email'] ?? '' ) );
		$message = sanitize_textarea_field( (string) ( $post['message'] ?? '' ) );

		if ( '' === $name || '' === $message || ! is_email( $email ) ) {
			return 'invalid';
		}

		if ( ! self::under_rate_limit( $remote_addr ) ) {
			return 'rate_limited';
		}

		$to      = get_option( 'admin_email' );
		$subject = sprintf( '[BeauClick] پیام جدید از فرم تماس — %s', $name );
		$body    = "نام: {$name}\nایمیل: {$email}\n\nپیام:\n{$message}";

		wp_mail( $to, $subject, $body, [ 'Reply-To: ' . $email ] );

		return 'sent';
	}

	/** Same transient-backed, phone/IP-scoped pattern already used by beauclick-auth's OTP requests — IP-scoped here since a contact form has no phone/session to key on. */
	private static function under_rate_limit( string $remote_addr ): bool {
		$key   = 'bc_contact_rl_' . md5( $remote_addr );
		$count = (int) get_transient( $key );
		if ( $count >= self::RATE_LIMIT_MAX ) {
			return false;
		}
		set_transient( $key, $count + 1, self::RATE_LIMIT_WINDOW );
		return true;
	}
}
