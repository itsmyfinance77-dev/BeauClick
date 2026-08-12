<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

require_once __DIR__ . '/support/upload-test-overrides.php';

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Verification\VerificationService;
use WP_UnitTestCase;

final class VerificationServiceTest extends WP_UnitTestCase {

	private const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

	private function make_provider(): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
	}

	/** @return array{name:string,tmp_name:string,size:int,error:int,type:string} */
	private function fake_file(): array {
		$contents = base64_decode( self::VALID_PNG_BASE64 );
		$path     = tempnam( sys_get_temp_dir(), 'bc-evidence-test-' );
		file_put_contents( $path, $contents );
		return [ 'name' => 'photo.png', 'tmp_name' => $path, 'size' => strlen( $contents ), 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ];
	}

	public function test_a_new_provider_starts_unverified(): void {
		$provider_id = $this->make_provider();
		$this->assertSame( 'unverified', ( new VerificationService() )->current_status( $provider_id ) );
	}

	public function test_submitting_a_request_moves_status_to_pending(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();

		$result = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );

		$this->assertIsArray( $result );
		$this->assertSame( 'pending', $service->current_status( $provider_id ) );
	}

	public function test_submitting_a_request_without_any_evidence_is_rejected(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();

		$result = $service->submit_request( $provider_id, 1, [], [] );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_evidence_required', $result->get_error_code() );
		$this->assertSame( 'unverified', $service->current_status( $provider_id ), 'A rejected submission must not change the provider status.' );
	}

	public function test_cannot_submit_a_second_request_while_one_is_already_pending(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );

		$result = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_invalid_transition', $result->get_error_code() );
	}

	public function test_admin_approving_a_pending_request_moves_to_verified(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$reviewer_id = self::factory()->user->create();

		$ok = $service->decide( $submitted['requestId'], $reviewer_id, 'verified', '' );

		$this->assertTrue( $ok );
		$this->assertSame( 'verified', $service->current_status( $provider_id ) );
		$stored_reviewer = $wpdb->get_var( $wpdb->prepare( "SELECT decided_by FROM {$wpdb->prefix}bc_verification_requests WHERE id = %d", $submitted['requestId'] ) );
		$this->assertSame( (string) $reviewer_id, $stored_reviewer );
	}

	public function test_rejecting_a_pending_request_moves_to_rejected_and_stores_the_reason(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$reviewer_id = self::factory()->user->create();

		$service->decide( $submitted['requestId'], $reviewer_id, 'rejected', 'تصویر مدرک ناخوانا است.' );

		$this->assertSame( 'rejected', $service->current_status( $provider_id ) );
		$summary = $service->summary( $provider_id );
		$this->assertSame( 'تصویر مدرک ناخوانا است.', $summary['latestRequest']['decisionReason'] );
	}

	public function test_a_request_cannot_be_decided_twice(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$reviewer_id = self::factory()->user->create();
		$service->decide( $submitted['requestId'], $reviewer_id, 'verified', '' );

		$second = $service->decide( $submitted['requestId'], $reviewer_id, 'rejected', 'دیر شد' );

		$this->assertInstanceOf( \WP_Error::class, $second, 'A request already decided must be immutable -- a second decide() call must never overwrite the outcome.' );
		$this->assertSame( 'verified', $service->current_status( $provider_id ) );
	}

	public function test_a_verified_provider_can_be_suspended_and_reinstated(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$service->decide( $submitted['requestId'], self::factory()->user->create(), 'verified', '' );

		$service->suspend( $provider_id, self::factory()->user->create(), 'شکایت مشتری در حال بررسی' );
		$this->assertSame( 'suspended', $service->current_status( $provider_id ) );

		$service->reinstate( $provider_id, self::factory()->user->create(), 'بررسی به نفع متخصص تمام شد' );
		$this->assertSame( 'verified', $service->current_status( $provider_id ) );
	}

	public function test_a_verified_provider_can_be_revoked_and_a_revoked_provider_can_reapply(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$service->decide( $submitted['requestId'], self::factory()->user->create(), 'verified', '' );

		$service->revoke( $provider_id, self::factory()->user->create(), 'تخلف جدی احراز شد' );
		$this->assertSame( 'revoked', $service->current_status( $provider_id ) );

		$reapply = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$this->assertIsArray( $reapply, 'A revoked provider must still be able to submit a fresh request (revoked -> pending is a valid transition).' );
		$this->assertSame( 'pending', $service->current_status( $provider_id ) );
	}

	public function test_suspending_an_unverified_provider_is_rejected(): void {
		$provider_id = $this->make_provider();
		$service     = new VerificationService();

		$result = $service->suspend( $provider_id, self::factory()->user->create(), 'نامعتبر' );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'bc_invalid_transition', $result->get_error_code() );
		$this->assertSame( 'unverified', $service->current_status( $provider_id ) );
	}

	public function test_transition_history_is_append_only_and_chronological(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );
		$service->decide( $submitted['requestId'], self::factory()->user->create(), 'verified', '' );
		$service->suspend( $provider_id, self::factory()->user->create(), 'دلیل تعلیق' );

		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT from_status, to_status FROM {$wpdb->prefix}bc_verification_history WHERE provider_id = %d ORDER BY id ASC", $provider_id ),
			ARRAY_A
		);

		$this->assertCount( 3, $rows, 'unverified->pending, pending->verified, verified->suspended -- every real transition must leave its own row.' );
		$this->assertSame( [ 'unverified', 'pending' ], [ $rows[0]['from_status'], $rows[0]['to_status'] ] );
		$this->assertSame( [ 'pending', 'verified' ], [ $rows[1]['from_status'], $rows[1]['to_status'] ] );
		$this->assertSame( [ 'verified', 'suspended' ], [ $rows[2]['from_status'], $rows[2]['to_status'] ] );
	}

	public function test_verifying_a_provider_marks_it_verified_in_the_ranking_index(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$service     = new VerificationService();
		$submitted   = $service->submit_request( $provider_id, 1, [ $this->fake_file() ], [ 'identity' ] );

		$before = $wpdb->get_var( $wpdb->prepare( "SELECT verified FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) );
		$this->assertSame( '0', $before );

		$service->decide( $submitted['requestId'], self::factory()->user->create(), 'verified', '' );
		$after_verify = $wpdb->get_var( $wpdb->prepare( "SELECT verified FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) );
		$this->assertSame( '1', $after_verify );

		$service->suspend( $provider_id, self::factory()->user->create(), 'تعلیق' );
		$after_suspend = $wpdb->get_var( $wpdb->prepare( "SELECT verified FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) );
		$this->assertSame( '0', $after_suspend, 'A suspended provider must never still count as verified in the ranking/search index.' );
	}

	public function test_can_transition_matrix(): void {
		$service = new VerificationService();

		$this->assertTrue( $service->can_transition( 'unverified', 'pending' ) );
		$this->assertTrue( $service->can_transition( 'pending', 'verified' ) );
		$this->assertTrue( $service->can_transition( 'pending', 'rejected' ) );
		$this->assertTrue( $service->can_transition( 'rejected', 'pending' ) );
		$this->assertTrue( $service->can_transition( 'verified', 'suspended' ) );
		$this->assertTrue( $service->can_transition( 'verified', 'revoked' ) );
		$this->assertTrue( $service->can_transition( 'suspended', 'verified' ) );
		$this->assertTrue( $service->can_transition( 'suspended', 'revoked' ) );
		$this->assertTrue( $service->can_transition( 'revoked', 'pending' ) );

		$this->assertFalse( $service->can_transition( 'unverified', 'verified' ), 'A provider must go through a real review -- there is no direct shortcut to verified.' );
		$this->assertFalse( $service->can_transition( 'pending', 'suspended' ) );
		$this->assertFalse( $service->can_transition( 'verified', 'pending' ) );
		$this->assertFalse( $service->can_transition( 'rejected', 'verified' ) );
	}
}
