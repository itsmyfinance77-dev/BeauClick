<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\Professional\ProfessionalContext;
use BeauClick\Campaigns\CampaignService;
use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class ProfessionalContextTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id, string $post_type = Registrar::PROFESSIONAL ): int {
		return self::factory()->post->create( [ 'post_type' => $post_type, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_booking( int $provider_id, int $customer_id, string $status = 'completed' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 0,
				'slot_start'  => current_time( 'mysql' ),
				'slot_end'    => current_time( 'mysql' ),
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return (int) $wpdb->insert_id;
	}

	public function test_analytics_section_matches_metrics_service_for_this_provider_only(): void {
		$owner_a    = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$customer   = self::factory()->user->create();
		$this->make_booking( $provider_a, $customer );

		$owner_b    = self::factory()->user->create();
		$provider_b = $this->make_provider( $owner_b );
		$this->make_booking( $provider_b, $customer );
		$this->make_booking( $provider_b, $customer );

		$context = ( new ProfessionalContext() )->for_provider( $provider_a, Registrar::PROFESSIONAL );

		$this->assertSame( 1, $context['analytics']['customers']['total'], "Provider A's context must reflect only provider A's own booking, never provider B's." );
	}

	public function test_financial_section_reflects_only_this_partys_ledger(): void {
		CommissionConfig::set_rate( 15 );
		$owner_a    = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$booking_a  = $this->make_booking( $provider_a, self::factory()->user->create() );

		$owner_b    = self::factory()->user->create();
		$provider_b = $this->make_provider( $owner_b );
		$booking_b  = $this->make_booking( $provider_b, self::factory()->user->create() );

		( new LedgerService() )->record_payment( 5001, $booking_a, LedgerService::PARTY_PROFESSIONAL, $provider_a, 1000000 );
		( new LedgerService() )->record_payment( 5002, $booking_b, LedgerService::PARTY_PROFESSIONAL, $provider_b, 9000000 );

		$context = ( new ProfessionalContext() )->for_provider( $provider_a, Registrar::PROFESSIONAL );

		$this->assertSame( 850000, $context['financial']['summary']['receivableNet'], "Provider A's own receivable (1,000,000 minus 15% commission) must be exact, never mixed with provider B's much larger figure." );
	}

	public function test_business_post_type_resolves_the_business_party_type(): void {
		CommissionConfig::set_rate( 15 );
		$owner    = self::factory()->user->create();
		$business = $this->make_provider( $owner, Registrar::BUSINESS );
		$booking  = $this->make_booking( $business, self::factory()->user->create() );

		( new LedgerService() )->record_payment( 5003, $booking, LedgerService::PARTY_BUSINESS, $business, 2000000 );

		$context = ( new ProfessionalContext() )->for_provider( $business, Registrar::BUSINESS );

		$this->assertSame( 1700000, $context['financial']['summary']['receivableNet'] );
	}

	public function test_campaigns_section_includes_only_active_campaigns_targeting_this_provider_or_platform_wide(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$other    = $this->make_provider( self::factory()->user->create() );

		$campaigns = new CampaignService();
		$mine      = $campaigns->create( [ 'name' => 'کمپین من', 'discountType' => 'percentage', 'discountValue' => 10, 'providerId' => $provider ] );
		$campaigns->activate( $mine['id'] );
		$platform = $campaigns->create( [ 'name' => 'کمپین سراسری', 'discountType' => 'fixed', 'discountValue' => 50000 ] );
		$campaigns->activate( $platform['id'] );
		$theirs = $campaigns->create( [ 'name' => 'کمپین دیگری', 'discountType' => 'percentage', 'discountValue' => 20, 'providerId' => $other ] );
		$campaigns->activate( $theirs['id'] );
		$draft = $campaigns->create( [ 'name' => 'کمپین پیش‌نویس', 'discountType' => 'percentage', 'discountValue' => 5, 'providerId' => $provider ] );

		$context = ( new ProfessionalContext() )->for_provider( $provider, Registrar::PROFESSIONAL );
		$names   = array_column( $context['campaigns'], 'name' );

		$this->assertContains( 'کمپین من', $names );
		$this->assertContains( 'کمپین سراسری', $names );
		$this->assertNotContains( 'کمپین دیگری', $names, "Another provider's targeted campaign must never appear in this provider's context." );
		$this->assertNotContains( 'کمپین پیش‌نویس', $names, 'A draft (not yet active) campaign must never appear.' );
	}

	public function test_context_never_includes_a_customer_identity_field(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$customer = self::factory()->user->create( [ 'user_email' => 'private-customer@example.test' ] );
		$this->make_booking( $provider, $customer );

		$context = ( new ProfessionalContext() )->for_provider( $provider, Registrar::PROFESSIONAL );
		$payload = wp_json_encode( $context );

		$this->assertStringNotContainsString( 'private-customer@example.test', (string) $payload, 'ProfessionalContext must never leak a raw customer identity -- only aggregate counts.' );
	}
}
