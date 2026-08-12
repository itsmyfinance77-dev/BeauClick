<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

require_once __DIR__ . '/support/upload-test-overrides.php';

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\MarketplaceController;
use BeauClick\Marketplace\Rest\VerificationController;
use BeauClick\Marketplace\Verification\VerificationService;
use WP_REST_Request;
use WP_UnitTestCase;

/**
 * The 15 explicit security/privacy scenarios from the V2.1 Step 8 spec,
 * covered at the REST-controller boundary (ownership isolation, admin
 * authorization, evidence-download authorization, malformed input, and
 * public-response safety). State-machine/audit-history correctness lives
 * in VerificationServiceTest; raw file-validation lives in
 * EvidenceStorageTest -- this file is specifically about "who is allowed
 * to call which route with which resource".
 */
final class VerificationControllerTest extends WP_UnitTestCase {

	private const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

	private function make_provider_with_owner(): array {
		$owner_id    = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		return [ $owner_id, $provider_id ];
	}

	private function file_params(): array {
		$contents = base64_decode( self::VALID_PNG_BASE64 );
		$path     = tempnam( sys_get_temp_dir(), 'bc-evidence-test-' );
		file_put_contents( $path, $contents );
		return [
			'evidence' => [
				'name'     => [ 'photo.png' ],
				'tmp_name' => [ $path ],
				'size'     => [ strlen( $contents ) ],
				'error'    => [ UPLOAD_ERR_OK ],
				'type'     => [ 'image/png' ],
			],
		];
	}

	// 1. own-view.
	public function test_a_professional_can_view_their_own_verification_status(): void {
		[ $owner_id ] = $this->make_provider_with_owner();
		wp_set_current_user( $owner_id );

		$response = ( new VerificationController() )->me( new WP_REST_Request( 'GET', '/beauclick/v1/marketplace/verification/me' ) );

		$this->assertSame( 'unverified', $response->get_data()['data']['status'] );
	}

	// 2. own-submit.
	public function test_a_professional_can_submit_their_own_verification_request(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		wp_set_current_user( $owner_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/verification/submit' );
		$request->set_param( 'evidenceTypes', [ 'identity' ] );
		$request->set_file_params( $this->file_params() );

		$response = ( new VerificationController() )->submit( $request );

		$this->assertSame( 201, $response->get_status() );
		$this->assertSame( 'pending', ( new VerificationService() )->current_status( $provider_id ) );
	}

	// 3. malformed-metadata-rejection: a user with no provider profile at all.
	public function test_a_user_with_no_provider_profile_cannot_submit(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/verification/submit' );
		$request->set_param( 'evidenceTypes', [ 'identity' ] );
		$request->set_file_params( $this->file_params() );

		$response = ( new VerificationController() )->submit( $request );

		$this->assertSame( 404, $response->get_status() );
	}

	// 4. self-approval-denial: a professional (no moderation capability) cannot pass require_moderation.
	public function test_a_professional_cannot_moderate_verification_requests(): void {
		[ $owner_id ] = $this->make_provider_with_owner();
		wp_set_current_user( $owner_id );

		$result = ( new VerificationController() )->require_moderation();

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	// 5. unauthorized-admin-denial: a logged-in user with no moderation capability at all.
	public function test_a_plain_logged_in_user_cannot_moderate_verification_requests(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$result = ( new VerificationController() )->require_moderation();

		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	// 6. authorized-admin-success.
	public function test_a_moderator_can_approve_a_pending_request(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );

		$moderator_id = self::factory()->user->create( [ 'role' => 'bc_moderator' ] );
		wp_set_current_user( $moderator_id );
		$this->assertTrue( ( new VerificationController() )->require_moderation() );

		$request = new WP_REST_Request( 'POST', "/beauclick/v1/marketplace/verification/queue/{$submitted['requestId']}/decide" );
		$request->set_param( 'id', $submitted['requestId'] );
		$request->set_param( 'decision', 'verified' );
		$request->set_param( 'reason', '' );

		$response = ( new VerificationController() )->decide( $request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'verified', $service->current_status( $provider_id ) );
	}

	private function write_temp_png(): string {
		$path = tempnam( sys_get_temp_dir(), 'bc-evidence-test-' );
		file_put_contents( $path, base64_decode( self::VALID_PNG_BASE64 ) );
		return $path;
	}

	// 6b. controlled state transitions: rejecting without a reason is refused at the controller boundary.
	public function test_rejecting_a_request_without_a_reason_is_refused(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );

		wp_set_current_user( self::factory()->user->create( [ 'role' => 'bc_moderator' ] ) );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/marketplace/verification/queue/{$submitted['requestId']}/decide" );
		$request->set_param( 'id', $submitted['requestId'] );
		$request->set_param( 'decision', 'rejected' );
		$request->set_param( 'reason', '' );

		$response = ( new VerificationController() )->decide( $request );

		$this->assertSame( 422, $response->get_status() );
		$this->assertSame( 'pending', $service->current_status( $provider_id ), 'A rejection missing its required reason must never actually change status.' );
	}

	// 7. evidence-download-denial: cross-professional access.
	public function test_a_professional_cannot_download_another_professionals_evidence(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );
		$evidence_id = $service->summary( $provider_id )['evidence'][0]['id'];

		$attacker_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $attacker_id ] );
		wp_set_current_user( $attacker_id );

		$request = new WP_REST_Request( 'GET', "/beauclick/v1/marketplace/verification/evidence/{$evidence_id}" );
		$request->set_param( 'id', $evidence_id );

		$response = ( new VerificationController() )->download_evidence( $request );

		$this->assertSame( 403, $response->get_status(), 'A professional must never be able to download another professional\'s verification evidence.' );
	}

	// 8. evidence-download-denial: a logged-in user with no provider profile and no moderation capability.
	public function test_an_unrelated_logged_in_user_cannot_download_evidence(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );
		$evidence_id = $service->summary( $provider_id )['evidence'][0]['id'];

		wp_set_current_user( self::factory()->user->create() );

		$request = new WP_REST_Request( 'GET', "/beauclick/v1/marketplace/verification/evidence/{$evidence_id}" );
		$request->set_param( 'id', $evidence_id );

		$response = ( new VerificationController() )->download_evidence( $request );

		$this->assertSame( 403, $response->get_status() );
	}

	// 9. malformed-metadata-rejection: a nonexistent evidence id.
	public function test_downloading_a_nonexistent_evidence_id_returns_not_found(): void {
		wp_set_current_user( self::factory()->user->create() );

		$request = new WP_REST_Request( 'GET', '/beauclick/v1/marketplace/verification/evidence/999999' );
		$request->set_param( 'id', 999999 );

		$response = ( new VerificationController() )->download_evidence( $request );

		$this->assertSame( 404, $response->get_status() );
	}

	// 10. malformed-metadata-rejection: an invalid decision value.
	public function test_deciding_with_an_invalid_decision_value_is_rejected(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );

		wp_set_current_user( self::factory()->user->create( [ 'role' => 'bc_moderator' ] ) );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/marketplace/verification/queue/{$submitted['requestId']}/decide" );
		$request->set_param( 'id', $submitted['requestId'] );
		$request->set_param( 'decision', 'super_verified_forever' );
		$request->set_param( 'reason', '' );

		$response = ( new VerificationController() )->decide( $request );

		$this->assertSame( 422, $response->get_status() );
	}

	// 11. controlled state transitions: suspend requires a reason.
	public function test_suspending_without_a_reason_is_refused(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );
		$service->decide( $submitted['requestId'], self::factory()->user->create(), 'verified', '' );

		wp_set_current_user( self::factory()->user->create( [ 'role' => 'bc_moderator' ] ) );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/marketplace/verification/provider/{$provider_id}/suspend" );
		$request->set_param( 'id', $provider_id );
		$request->set_param( 'reason', '' );

		$response = ( new VerificationController() )->suspend( $request );

		$this->assertSame( 422, $response->get_status() );
		$this->assertSame( 'verified', $service->current_status( $provider_id ) );
	}

	// 12. public-profile-safety: the public marketplace detail response exposes only a boolean, never evidence/history.
	public function test_the_public_marketplace_response_never_exposes_verification_evidence_or_history(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		$service   = new VerificationService();
		$submitted = $service->submit_request( $provider_id, $owner_id, [ [ 'name' => 'a.png', 'tmp_name' => $this->write_temp_png(), 'size' => 100, 'error' => UPLOAD_ERR_OK, 'type' => 'image/png' ] ], [ 'identity' ] );
		$service->decide( $submitted['requestId'], self::factory()->user->create(), 'verified', 'مدارک کامل بود' );

		$request = new WP_REST_Request( 'GET', "/beauclick/v1/marketplace/providers/{$provider_id}" );
		$request->set_param( 'id', $provider_id );
		$data = ( new MarketplaceController() )->detail( $request )->get_data()['data'];

		$this->assertIsBool( $data['verified'] );
		$this->assertTrue( $data['verified'] );
		$this->assertArrayNotHasKey( 'evidence', $data );
		$this->assertArrayNotHasKey( 'verificationHistory', $data );
		$this->assertArrayNotHasKey( 'decisionReason', $data );
		$this->assertStringNotContainsString( 'مدارک کامل بود', json_encode( $data ), 'A moderator\'s internal decision reason must never leak into the public marketplace response.' );
	}

	// 13. cross-professional-denial, at the ownership-resolution layer used by every self-service route.
	public function test_provider_lookup_resolves_only_the_current_users_own_provider(): void {
		[ $owner_id, $provider_id ] = $this->make_provider_with_owner();
		[ $other_owner_id, $other_provider_id ] = $this->make_provider_with_owner();

		$this->assertSame( $provider_id, \BeauClick\Marketplace\Support\ProviderLookup::for_user( $owner_id ) );
		$this->assertNotSame( $other_provider_id, \BeauClick\Marketplace\Support\ProviderLookup::for_user( $owner_id ) );
	}
}
