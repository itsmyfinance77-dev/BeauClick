<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\Professional\ProfessionalAssistantService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class ProfessionalAssistantServiceTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	public function test_a_second_message_reuses_the_same_conversation(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$service  = new ProfessionalAssistantService();

		$first  = $service->send( $provider, Registrar::PROFESSIONAL, $owner, 'سلام' );
		$second = $service->send( $provider, Registrar::PROFESSIONAL, $owner, 'دوباره سلام' );

		$this->assertIsArray( $first );
		$this->assertIsArray( $second );
		$this->assertSame( $first['userMessage']['conversationId'], $second['userMessage']['conversationId'] );
	}

	public function test_blank_message_is_rejected_with_a_string_error_not_persisted(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$service  = new ProfessionalAssistantService();

		$result = $service->send( $provider, Registrar::PROFESSIONAL, $owner, '   ' );
		$this->assertIsString( $result );

		$conversation = $service->get_or_create_conversation( $provider, $owner );
		$this->assertCount( 0, $service->messages( $conversation['id'] ) );
	}

	public function test_rate_limit_blocks_a_burst_beyond_the_cap(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$service  = new ProfessionalAssistantService();

		for ( $i = 0; $i < 15; $i++ ) {
			$this->assertIsArray( $service->send( $provider, Registrar::PROFESSIONAL, $owner, "پیام {$i}" ), "Message {$i} should still be within the rate limit." );
		}

		$this->assertFalse( $service->send( $provider, Registrar::PROFESSIONAL, $owner, 'یک پیام دیگر' ), 'A 16th message within the window must be rate-limited.' );
	}

	/**
	 * Task §28: professional AI must not share/bypass the customer AI's own
	 * rate-limit bucket -- a professional who is also a heavy customer-AI
	 * user must still get their own full professional-AI allowance.
	 */
	public function test_professional_ai_rate_limit_is_independent_from_customer_ai(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );

		set_transient( "bc_ai_rate_{$owner}", 15, MINUTE_IN_SECONDS );

		$service = new ProfessionalAssistantService();
		$this->assertIsArray( $service->send( $provider, Registrar::PROFESSIONAL, $owner, 'سلام' ), 'Exhausting the customer AI rate limit must not affect professional AI.' );
	}

	/**
	 * The core cross-professional isolation guarantee at the service layer:
	 * a conversation id belonging to provider A must never validate against
	 * provider B, regardless of who is asking.
	 */
	public function test_conversation_belongs_to_is_strict_per_provider(): void {
		$owner_a    = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$owner_b    = self::factory()->user->create();
		$provider_b = $this->make_provider( $owner_b );

		$service       = new ProfessionalAssistantService();
		$conversation_a = $service->get_or_create_conversation( $provider_a, $owner_a );

		$this->assertTrue( $service->conversation_belongs_to( $conversation_a['id'], $provider_a ) );
		$this->assertFalse( $service->conversation_belongs_to( $conversation_a['id'], $provider_b ), "Provider B must never be recognized as the owner of provider A's conversation." );
	}

	/**
	 * V2.3 final release audit finding: this table pair was never wired into
	 * beauclick-privacy's export/deletion sweep — export_for_user()/
	 * forget_user() are the two methods that fix closes that gap with (see
	 * DeletionServiceTest/ExportServiceTest in beauclick-privacy for the
	 * cross-plugin wiring itself).
	 */
	public function test_export_for_user_returns_the_conversation_transcript(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$service  = new ProfessionalAssistantService();
		$service->send( $provider, Registrar::PROFESSIONAL, $owner, 'وضعیت این ماه چطور است؟' );

		$export = $service->export_for_user( $owner );

		$this->assertCount( 2, $export, 'Both the professional\'s own message and the assistant\'s reply must be exported.' );
		$this->assertSame( 'professional', $export[0]['from'] );
		$this->assertSame( 'وضعیت این ماه چطور است؟', $export[0]['body'] );
		$this->assertSame( 'assistant', $export[1]['from'] );
	}

	public function test_export_for_user_returns_empty_for_a_professional_who_never_used_it(): void {
		$owner = self::factory()->user->create();
		$this->assertSame( [], ( new ProfessionalAssistantService() )->export_for_user( $owner ) );
	}

	public function test_forget_user_deletes_the_conversation_and_its_messages(): void {
		global $wpdb;
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$service  = new ProfessionalAssistantService();
		$service->send( $provider, Registrar::PROFESSIONAL, $owner, 'یک پیام برای حذف' );

		$service->forget_user( $owner );

		$this->assertNull( $service->find_conversation_for_user( $owner ) );
		$remaining = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_ai_professional_messages WHERE conversation_id NOT IN (SELECT id FROM {$wpdb->prefix}bc_ai_professional_conversations)" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$this->assertSame( 0, $remaining, 'forget_user() must not leave orphaned message rows behind.' );
	}

	public function test_forget_user_is_a_noop_for_a_professional_with_no_conversation(): void {
		$owner = self::factory()->user->create();
		( new ProfessionalAssistantService() )->forget_user( $owner ); // Must not throw.
		$this->assertNull( ( new ProfessionalAssistantService() )->find_conversation_for_user( $owner ) );
	}

	public function test_two_different_providers_get_two_different_conversations(): void {
		$owner_a    = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$owner_b    = self::factory()->user->create();
		$provider_b = $this->make_provider( $owner_b );

		$service = new ProfessionalAssistantService();
		$conversation_a = $service->get_or_create_conversation( $provider_a, $owner_a );
		$conversation_b = $service->get_or_create_conversation( $provider_b, $owner_b );

		$this->assertNotSame( $conversation_a['id'], $conversation_b['id'] );
	}

	public function test_the_default_rule_based_provider_never_fabricates_and_reflects_real_zeroed_context(): void {
		$owner    = self::factory()->user->create();
		$provider = $this->make_provider( $owner );
		$service  = new ProfessionalAssistantService();

		$result = $service->send( $provider, Registrar::PROFESSIONAL, $owner, 'درآمد من چقدره؟' );

		$this->assertIsArray( $result );
		// A brand-new provider has no ledger entries -- the reply must state
		// a real zero, never omit the fact or invent a nonzero figure.
		// Rendered in Persian digits like every other number in this reply
		// (Global UI/UX audit) -- a literal '0' never appears on screen.
		$this->assertStringContainsString( '۰', $result['assistantMessage']['body'] );
	}
}
