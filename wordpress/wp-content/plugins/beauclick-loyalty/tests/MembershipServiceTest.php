<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Loyalty\Membership\MembershipService;
use WP_UnitTestCase;

final class MembershipServiceTest extends WP_UnitTestCase {

	private function make_plan( array $overrides = [] ): array {
		$service = new MembershipService();
		$result  = $service->create_plan(
			$overrides['slug'] ?? 'plus',
			$overrides['name'] ?? 'پلاس',
			$overrides['tierId'] ?? null,
			$overrides['isPaid'] ?? false,
			$overrides['price'] ?? null,
			$overrides['billingPeriodDays'] ?? null
		);
		return $service->find_plan( $result['id'] );
	}

	// 7. Membership activation.
	public function test_activating_a_plan_creates_an_active_membership(): void {
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan();

		$result = ( new MembershipService() )->activate( $user_id, $plan['id'], 'manual' );

		$this->assertIsArray( $result );
		$membership = ( new MembershipService() )->for_user( $user_id );
		$this->assertSame( 'active', $membership['status'] );
		$this->assertSame( $plan['id'], $membership['planId'] );
	}

	public function test_a_user_with_no_membership_returns_null(): void {
		$user_id = self::factory()->user->create();
		$this->assertNull( ( new MembershipService() )->for_user( $user_id ) );
	}

	// 12. Idempotent tier/membership transitions.
	public function test_activating_the_same_plan_twice_does_not_create_a_second_row(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan();
		$service = new MembershipService();

		$service->activate( $user_id, $plan['id'], 'manual' );
		$service->activate( $user_id, $plan['id'], 'manual' );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_memberships WHERE user_id = %d", $user_id ) );
		$this->assertSame( 1, $count, 'The UNIQUE KEY on user_id must make a second activation an update, never a duplicate row.' );
	}

	public function test_activating_a_new_plan_replaces_the_existing_membership_row(): void {
		$user_id = self::factory()->user->create();
		$basic   = $this->make_plan( [ 'slug' => 'basic', 'name' => 'پایه' ] );
		$plus    = $this->make_plan( [ 'slug' => 'plus2', 'name' => 'پلاس دو' ] );
		$service = new MembershipService();

		$service->activate( $user_id, $basic['id'], 'manual' );
		$service->activate( $user_id, $plus['id'], 'manual' );

		$this->assertSame( $plus['id'], $service->for_user( $user_id )['planId'] );
	}

	public function test_activating_an_inactive_plan_is_rejected(): void {
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan();
		$service = new MembershipService();
		$service->update_plan( $plan['id'], [ 'isActive' => false ] );

		$result = $service->activate( $user_id, $plan['id'], 'manual' );

		$this->assertIsString( $result );
		$this->assertNull( $service->for_user( $user_id ) );
	}

	public function test_cancelling_an_active_membership_sets_status_cancelled(): void {
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan();
		$service = new MembershipService();
		$service->activate( $user_id, $plan['id'], 'manual' );

		$result = $service->cancel( $user_id );

		$this->assertTrue( $result );
		$this->assertSame( 'cancelled', $service->for_user( $user_id )['status'] );
	}

	public function test_cancelling_a_membership_that_does_not_exist_is_rejected(): void {
		$user_id = self::factory()->user->create();
		$result  = ( new MembershipService() )->cancel( $user_id );
		$this->assertIsString( $result );
	}

	// 8. Membership expiry.
	public function test_expire_due_marks_a_past_expiry_membership_as_expired(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan( [ 'billingPeriodDays' => 30 ] );
		$service = new MembershipService();
		$service->activate( $user_id, $plan['id'], 'manual' );

		// Force the row into the past -- activate() always computes a future
		// expiry from "now", so the only way to test the sweep is to
		// directly backdate the persisted row, exactly as real elapsed time
		// would.
		$wpdb->update( $wpdb->prefix . 'bc_memberships', [ 'expires_at' => '2020-01-01 00:00:00' ], [ 'user_id' => $user_id ] );

		$expired_count = $service->expire_due();

		$this->assertSame( 1, $expired_count );
		$this->assertSame( 'expired', $service->for_user( $user_id )['status'] );
	}

	public function test_expire_due_never_touches_a_membership_with_no_expiry(): void {
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan(); // No billingPeriodDays -- expires_at stays NULL (a non-expiring plan).
		$service = new MembershipService();
		$service->activate( $user_id, $plan['id'], 'manual' );

		$service->expire_due();

		$this->assertSame( 'active', $service->for_user( $user_id )['status'], 'A membership with no expiry date must never be swept as expired.' );
	}

	public function test_expire_due_never_touches_a_membership_not_yet_due(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();
		$plan    = $this->make_plan( [ 'billingPeriodDays' => 30 ] );
		$service = new MembershipService();
		$service->activate( $user_id, $plan['id'], 'manual' );

		$service->expire_due();

		$this->assertSame( 'active', $service->for_user( $user_id )['status'], 'A membership expiring 30 days from now must not be swept yet.' );
	}

	// V2.2 Step 14 — account deletion must block on a real, unresolved commercial commitment.
	public function test_has_active_paid_membership_is_true_only_for_an_active_paid_plan(): void {
		$service = new MembershipService();

		$free_user = self::factory()->user->create();
		$free_plan = $this->make_plan( [ 'slug' => 'free', 'isPaid' => false ] );
		$service->activate( $free_user, $free_plan['id'], 'manual' );
		$this->assertFalse( $service->has_active_paid_membership( $free_user ), 'A free plan must never block deletion.' );

		$paid_user = self::factory()->user->create();
		$paid_plan = $this->make_plan( [ 'slug' => 'paid', 'isPaid' => true, 'price' => 100000 ] );
		$service->activate( $paid_user, $paid_plan['id'], 'manual' );
		$this->assertTrue( $service->has_active_paid_membership( $paid_user ) );

		$cancelled_user = self::factory()->user->create();
		$service->activate( $cancelled_user, $paid_plan['id'], 'manual' );
		$service->cancel( $cancelled_user );
		$this->assertFalse( $service->has_active_paid_membership( $cancelled_user ), 'A cancelled paid membership must no longer block deletion.' );
	}

	public function test_has_active_paid_membership_is_false_for_a_user_with_no_membership_at_all(): void {
		$user_id = self::factory()->user->create();
		$this->assertFalse( ( new MembershipService() )->has_active_paid_membership( $user_id ) );
	}
}
