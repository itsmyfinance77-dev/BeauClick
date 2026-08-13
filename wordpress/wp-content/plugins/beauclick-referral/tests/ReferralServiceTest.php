<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Tests;

use BeauClick\Referral\ReferralService;
use WP_UnitTestCase;

final class ReferralServiceTest extends WP_UnitTestCase {

	public function set_up(): void {
		parent::set_up();
		add_filter( 'pre_wp_mail', '__return_true' ); // Reward path notifies both sides -- don't actually try to send mail in tests.
	}

	public function tear_down(): void {
		remove_filter( 'pre_wp_mail', '__return_true' );
		parent::tear_down();
	}

	// 1. a user's code is stable across repeated calls, not regenerated each time.
	public function test_get_or_create_code_is_stable(): void {
		$user_id = self::factory()->user->create();
		$service = new ReferralService();

		$first  = $service->get_or_create_code( $user_id );
		$second = $service->get_or_create_code( $user_id );

		$this->assertSame( $first, $second );
		$this->assertMatchesRegularExpression( '/^[A-Z0-9]{8}$/', $first );
	}

	// 2. attribute() creates a real, pending referral row and logs the event.
	public function test_attribute_creates_a_pending_referral(): void {
		global $wpdb;
		$referrer = self::factory()->user->create();
		$referee  = self::factory()->user->create();
		$code     = ( new ReferralService() )->get_or_create_code( $referrer );

		$ok = ( new ReferralService() )->attribute( $code, $referee );

		$this->assertTrue( $ok );
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d", $referee ),
			ARRAY_A
		);
		$this->assertSame( (string) $referrer, $row['referrer_user_id'] );
		$this->assertSame( 'pending', $row['status'] );

		$logged = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'referral_signup_attributed' AND entity_id = %d", $row['id'] )
		);
		$this->assertSame( 1, $logged );
	}

	// 3. an unknown/forged code never attributes anything.
	public function test_attribute_rejects_an_unknown_code(): void {
		$referee = self::factory()->user->create();
		$ok      = ( new ReferralService() )->attribute( 'NOTAREALCODE', $referee );
		$this->assertFalse( $ok );
	}

	// 4. self-referral guard: even though structurally near-impossible via
	// the real attribution flow (a code only exists for an account that
	// already exists, and attribute() is only ever called for a brand-new
	// account), the guard itself is tested directly rather than trusted by
	// construction alone.
	public function test_attribute_rejects_a_self_referral(): void {
		$user = self::factory()->user->create();
		$code = ( new ReferralService() )->get_or_create_code( $user );

		$ok = ( new ReferralService() )->attribute( $code, $user );

		$this->assertFalse( $ok );
	}

	// 5. the UNIQUE(referee_user_id) constraint is the real anti-replay
	// guarantee -- a user who was already referred once cannot be
	// attributed again via a second (possibly different) code.
	public function test_attribute_prevents_a_referee_being_attributed_twice(): void {
		$referrer_a = self::factory()->user->create();
		$referrer_b = self::factory()->user->create();
		$referee    = self::factory()->user->create();
		$service    = new ReferralService();

		$code_a = $service->get_or_create_code( $referrer_a );
		$code_b = $service->get_or_create_code( $referrer_b );

		$this->assertTrue( $service->attribute( $code_a, $referee ) );
		$this->assertFalse( $service->attribute( $code_b, $referee ) );
	}

	// 6. qualify() transitions pending -> qualified -> rewarded and awards
	// BOTH sides through the real loyalty ledger -- the actual end-to-end
	// path this whole domain exists for.
	public function test_qualify_rewards_both_referrer_and_referee_via_loyalty_ledger(): void {
		global $wpdb;
		$referrer = self::factory()->user->create();
		$referee  = self::factory()->user->create();
		$service  = new ReferralService();

		$code = $service->get_or_create_code( $referrer );
		$service->attribute( $code, $referee );

		$service->qualify( $referee );

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d", $referee ),
			ARRAY_A
		);
		$this->assertSame( 'rewarded', $row['status'] );

		$ledger = beauclick_loyalty()->ledger();
		$this->assertSame( \BeauClick\Referral\ReferralConfig::DEFAULT_REFERRER_REWARD_POINTS, $ledger->balance( $referrer ) );
		$this->assertSame( \BeauClick\Referral\ReferralConfig::DEFAULT_REFEREE_REWARD_POINTS, $ledger->balance( $referee ) );
	}

	// 7. idempotency: calling qualify() twice for the same referee must not
	// double-reward either side (the status-guarded UPDATE + has_awarded()
	// guards this at two layers).
	public function test_qualify_is_idempotent(): void {
		$referrer = self::factory()->user->create();
		$referee  = self::factory()->user->create();
		$service  = new ReferralService();

		$code = $service->get_or_create_code( $referrer );
		$service->attribute( $code, $referee );

		$service->qualify( $referee );
		$service->qualify( $referee ); // Simulates a booking completion followed later by a shop order for the same referee.

		$ledger = beauclick_loyalty()->ledger();
		$this->assertSame( \BeauClick\Referral\ReferralConfig::DEFAULT_REFERRER_REWARD_POINTS, $ledger->balance( $referrer ) );
		$this->assertSame( \BeauClick\Referral\ReferralConfig::DEFAULT_REFEREE_REWARD_POINTS, $ledger->balance( $referee ) );
	}

	// 8. qualify() on a user with no pending referral is a safe no-op (the
	// common case -- most bookings/orders have nothing to do with a
	// referral at all).
	public function test_qualify_is_a_noop_with_no_pending_referral(): void {
		$user = self::factory()->user->create();
		( new ReferralService() )->qualify( $user ); // Must not throw or error.
		$this->assertTrue( true );
	}

	// 9. summary_for_user() reflects real counts, not fabricated ones.
	public function test_summary_for_user_reports_real_counts(): void {
		$referrer  = self::factory()->user->create();
		$referee_1 = self::factory()->user->create();
		$referee_2 = self::factory()->user->create();
		$service   = new ReferralService();
		$code      = $service->get_or_create_code( $referrer );

		$service->attribute( $code, $referee_1 );
		$service->attribute( $code, $referee_2 );
		$service->qualify( $referee_1 ); // Only one of the two qualifies.

		$summary = $service->summary_for_user( $referrer );

		$this->assertSame( $code, $summary['code'] );
		$this->assertSame( 2, $summary['referredCount'] );
		$this->assertSame( 1, $summary['qualifiedCount'] );
		$this->assertSame( 1, $summary['rewardedCount'] );
		$this->assertSame( \BeauClick\Referral\ReferralConfig::DEFAULT_REFERRER_REWARD_POINTS, $summary['pointsEarned'] );
	}
}
