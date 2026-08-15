<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Tests;

use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use BeauClick\Financial\Rest\MyFinanceController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;
use WP_UnitTestCase;

/**
 * Adversarial ownership testing, per task §33: identity is resolved
 * EXCLUSIVELY from the authenticated session (`ProviderLookup::for_user()`)
 * -- there is no request parameter this controller reads for a provider/
 * business id at all, so cross-party leakage would require this
 * resolution itself to be wrong, which is exactly what these tests assert
 * against, one professional at a time.
 */
final class MyFinanceControllerTest extends WP_UnitTestCase {

	public function set_up(): void {
		parent::set_up();
		CommissionConfig::set_rate( 15 );
	}

	private function make_professional_with_receivable( int $amount ): array {
		$owner = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$post  = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner ] );
		( new LedgerService() )->record_payment( random_int( 100000, 999999 ), random_int( 100000, 999999 ), LedgerService::PARTY_PROFESSIONAL, $post, $amount );
		return [ 'userId' => $owner, 'providerId' => $post ];
	}

	// 1. A professional sees exactly their own summary.
	public function test_a_professional_sees_their_own_summary(): void {
		$a = $this->make_professional_with_receivable( 1000000 );
		wp_set_current_user( $a['userId'] );

		$response = ( new MyFinanceController() )->summary( new WP_REST_Request() );
		$data     = $response->get_data()['data'];

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( $a['providerId'], $data['partyId'] );
		$this->assertSame( 850000, $data['summary']['receivableNet'] );
	}

	// 2. Professional A can never see Professional B's financial data -- the core adversarial test this step requires.
	public function test_professional_a_cannot_see_professional_b_financial_data(): void {
		$a = $this->make_professional_with_receivable( 1000000 );
		$b = $this->make_professional_with_receivable( 5000000 );

		wp_set_current_user( $a['userId'] );
		$response = ( new MyFinanceController() )->summary( new WP_REST_Request() );
		$data     = $response->get_data()['data'];

		$this->assertSame( $a['providerId'], $data['partyId'] );
		$this->assertNotSame( $b['providerId'], $data['partyId'] );
		$this->assertSame( 850000, $data['summary']['receivableNet'], "Professional A's own 15%-net figure must never be professional B's." );

		// The endpoint accepts no provider/business id parameter to attack in the first place -- confirmed by construction (no get_param() call anywhere in the controller), but re-asserted here: passing one changes nothing.
		$forged = new WP_REST_Request();
		$forged->set_param( 'provider_id', $b['providerId'] );
		$forged_response = ( new MyFinanceController() )->summary( $forged );
		$this->assertSame( $a['providerId'], $forged_response->get_data()['data']['partyId'], 'A forged provider_id request parameter must be completely ignored -- identity comes only from the authenticated session.' );
	}

	// 3. A logged-in user with no professional/business profile at all gets a clean 404, not another user's data or a fatal error.
	public function test_a_user_with_no_profile_gets_a_404(): void {
		$user = self::factory()->user->create();
		wp_set_current_user( $user );

		$response = ( new MyFinanceController() )->summary( new WP_REST_Request() );

		$this->assertSame( 404, $response->get_status() );
	}

	// 4. A business sees only its own party-type-scoped summary, never a professional's.
	public function test_a_business_sees_its_own_business_scoped_summary(): void {
		$owner = self::factory()->user->create( [ 'role' => 'bc_business' ] );
		$post  = self::factory()->post->create( [ 'post_type' => Registrar::BUSINESS, 'post_status' => 'publish', 'post_author' => $owner ] );
		( new LedgerService() )->record_payment( 700001, 700002, LedgerService::PARTY_BUSINESS, $post, 2000000 );

		wp_set_current_user( $owner );
		$response = ( new MyFinanceController() )->summary( new WP_REST_Request() );
		$data     = $response->get_data()['data'];

		$this->assertSame( 'business', $data['partyType'] );
		$this->assertSame( 1700000, $data['summary']['receivableNet'] );
	}
}
