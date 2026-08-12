<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Content\ContactFormHandler;
use WP_UnitTestCase;

/**
 * Same `pre_wp_mail` interception pattern already established by
 * BookingMailerTest. `ContactFormHandler::process()` is deliberately
 * exit()-free (see its own docblock) so it's directly unit-testable here,
 * with `handle()` (the real admin-post.php hook target, doing only the
 * redirect+exit around it) left untested by design -- exercising a real
 * exit() from PHPUnit isn't meaningful.
 */
final class ContactFormHandlerTest extends WP_UnitTestCase {

	private array $sent = [];

	public function set_up(): void {
		parent::set_up();
		$this->sent = [];
		add_filter( 'pre_wp_mail', [ $this, 'capture' ], 10, 2 );
	}

	public function tear_down(): void {
		remove_filter( 'pre_wp_mail', [ $this, 'capture' ], 10 );
		parent::tear_down();
	}

	public function capture( $null, array $atts ) {
		$this->sent[] = $atts;
		return true;
	}

	private function valid_post( array $overrides = [] ): array {
		return array_merge(
			[
				'_bc_contact_nonce' => wp_create_nonce( 'bc_contact_form' ),
				'name'              => 'مریم رضایی',
				'email'             => 'maryam@example.com',
				'message'           => 'سلام، یک سوال درباره رزرو داشتم.',
				'bc_website'        => '',
			],
			$overrides
		);
	}

	public function test_a_valid_submission_sends_mail_to_the_real_admin_email_and_returns_sent(): void {
		// Deliberately does not change the admin_email option here --
		// update_option( 'admin_email', ... ) itself triggers WordPress
		// core's own "admin email changed" confirmation notification via
		// wp_mail(), which pre_wp_mail would also capture as a second,
		// unrelated send and produce a false failure.
		$admin_email = get_option( 'admin_email' );

		$status = ContactFormHandler::process( $this->valid_post(), '127.0.0.1' );

		$this->assertSame( 'sent', $status );
		$this->assertCount( 1, $this->sent );
		$this->assertSame( $admin_email, $this->sent[0]['to'] );
		$this->assertStringContainsString( 'مریم رضایی', $this->sent[0]['message'] );
	}

	public function test_a_missing_nonce_is_rejected_without_sending_mail(): void {
		$status = ContactFormHandler::process( $this->valid_post( [ '_bc_contact_nonce' => 'not-a-real-nonce' ] ), '127.0.0.1' );

		$this->assertSame( 'invalid', $status );
		$this->assertCount( 0, $this->sent );
	}

	public function test_an_empty_name_is_rejected(): void {
		$status = ContactFormHandler::process( $this->valid_post( [ 'name' => '' ] ), '127.0.0.1' );

		$this->assertSame( 'invalid', $status );
		$this->assertCount( 0, $this->sent );
	}

	public function test_an_invalid_email_is_rejected(): void {
		$status = ContactFormHandler::process( $this->valid_post( [ 'email' => 'not-an-email' ] ), '127.0.0.1' );

		$this->assertSame( 'invalid', $status );
		$this->assertCount( 0, $this->sent );
	}

	public function test_an_empty_message_is_rejected(): void {
		$status = ContactFormHandler::process( $this->valid_post( [ 'message' => '' ] ), '127.0.0.1' );

		$this->assertSame( 'invalid', $status );
		$this->assertCount( 0, $this->sent );
	}

	public function test_a_filled_honeypot_pretends_success_without_actually_sending(): void {
		$status = ContactFormHandler::process( $this->valid_post( [ 'bc_website' => 'http://spam.example' ] ), '127.0.0.1' );

		$this->assertSame( 'sent', $status, 'A bot must never learn its submission was rejected.' );
		$this->assertCount( 0, $this->sent, 'But no real mail should ever be sent for a honeypot-triggered submission.' );
	}

	public function test_rate_limit_blocks_after_the_max_and_resets_per_ip(): void {
		for ( $i = 0; $i < 5; $i++ ) {
			$this->assertSame( 'sent', ContactFormHandler::process( $this->valid_post(), '203.0.113.5' ) );
		}

		$this->assertSame( 'rate_limited', ContactFormHandler::process( $this->valid_post(), '203.0.113.5' ), 'The 6th submission from the same IP within the window must be blocked.' );
		$this->assertCount( 5, $this->sent );

		$this->assertSame( 'sent', ContactFormHandler::process( $this->valid_post(), '198.51.100.9' ), 'A different IP must have its own, independent limit.' );
	}
}
