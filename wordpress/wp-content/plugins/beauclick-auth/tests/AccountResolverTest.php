<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Tests;

use BeauClick\Auth\Account\AccountResolver;
use WP_UnitTestCase;

final class AccountResolverTest extends WP_UnitTestCase {

	public function test_a_brand_new_phone_creates_a_new_customer_account(): void {
		$result = ( new AccountResolver() )->find_or_create_for_phone( '+989121110001' );

		$this->assertTrue( $result['isNew'] );
		$user = get_userdata( $result['userId'] );
		$this->assertNotFalse( $user );
		$this->assertContains( 'customer', $user->roles, 'A newly self-registered account must land in WooCommerce\'s own customer role, not a bespoke one.' );
		$this->assertSame( '09121110001', get_user_meta( $result['userId'], '_billing_phone', true ) );
	}

	public function test_resolving_the_same_phone_twice_returns_the_same_user_both_times(): void {
		$first  = ( new AccountResolver() )->find_or_create_for_phone( '+989121110002' );
		$second = ( new AccountResolver() )->find_or_create_for_phone( '+989121110002' );

		$this->assertSame( $first['userId'], $second['userId'] );
		$this->assertTrue( $first['isNew'] );
		$this->assertFalse( $second['isNew'], 'The second resolution of an already-linked phone must recognize the existing account, never create a duplicate.' );
	}

	public function test_an_existing_pre_auth_account_with_a_matching_billing_phone_is_linked_not_duplicated(): void {
		$existing_user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		update_user_meta( $existing_user_id, '_billing_phone', '09121110003' );

		$result = ( new AccountResolver() )->find_or_create_for_phone( '+989121110003' );

		$this->assertFalse( $result['isNew'], 'A real pre-existing account (created via wp-cli or a real checkout) with a matching billing phone must be linked, never treated as a fresh registration.' );
		$this->assertSame( $existing_user_id, $result['userId'] );

		global $wpdb;
		$linked = (int) $wpdb->get_var( $wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", '+989121110003' ) );
		$this->assertSame( $existing_user_id, $linked );
	}

	public function test_billing_phone_in_a_different_valid_format_still_links_correctly(): void {
		$existing_user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		update_user_meta( $existing_user_id, '_billing_phone', '+98 912 111 0004' ); // deliberately a differently-formatted but equivalent number

		$result = ( new AccountResolver() )->find_or_create_for_phone( '+989121110004' );

		$this->assertSame( $existing_user_id, $result['userId'] );
		$this->assertFalse( $result['isNew'] );
	}

	public function test_multiple_existing_accounts_sharing_a_billing_phone_are_never_silently_merged(): void {
		$user_a = self::factory()->user->create( [ 'role' => 'customer' ] );
		$user_b = self::factory()->user->create( [ 'role' => 'customer' ] );
		update_user_meta( $user_a, '_billing_phone', '09121110005' );
		update_user_meta( $user_b, '_billing_phone', '09121110005' );

		$result = ( new AccountResolver() )->find_or_create_for_phone( '+989121110005' );

		$this->assertTrue( $result['isNew'], 'A genuine data conflict must never be resolved by guessing -- a fresh account is the only safe outcome.' );
		$this->assertNotContains( $result['userId'], [ $user_a, $user_b ] );

		global $wpdb;
		$conflict = $wpdb->get_row( $wpdb->prepare( "SELECT candidate_user_ids FROM {$wpdb->prefix}bc_phone_conflicts WHERE phone_canonical = %s", '+989121110005' ), ARRAY_A );
		$this->assertNotNull( $conflict, 'The conflict must be recorded for a human to resolve, not silently dropped.' );
		$candidates = json_decode( $conflict['candidate_user_ids'], true );
		sort( $candidates );
		$expected = [ $user_a, $user_b ];
		sort( $expected );
		$this->assertSame( $expected, $candidates );
	}

	public function test_a_user_already_linked_to_a_different_phone_is_not_offered_as_a_billing_phone_candidate_for_this_one(): void {
		// Regression guard: an account already verified for phone X must never be silently re-pointed at phone Y just because its (unrelated, unverified) billing_phone metadata happens to match Y.
		$user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		update_user_meta( $user_id, '_billing_phone', '09121110006' );
		( new AccountResolver() )->find_or_create_for_phone( '+989121110006' ); // links user to +989121110006

		update_user_meta( $user_id, '_billing_phone', '09121110007' ); // billing address later edited to a different number, unverified

		$result = ( new AccountResolver() )->find_or_create_for_phone( '+989121110007' );

		$this->assertTrue( $result['isNew'] );
		$this->assertNotSame( $user_id, $result['userId'], 'An already phone-verified account must not be reassigned to a second number just because a later billing-address edit happens to match it.' );
	}
}
