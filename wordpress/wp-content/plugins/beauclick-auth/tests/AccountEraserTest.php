<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Tests;

use BeauClick\Auth\Account\AccountEraser;
use BeauClick\Auth\Account\AccountResolver;
use WP_UnitTestCase;

/**
 * V2.2 Step 14 — the identity-layer half of account deletion. These tests
 * specifically prove §10's own requirement: a deleted account + the same
 * phone number must never resurrect the old identity.
 */
final class AccountEraserTest extends WP_UnitTestCase {

	private function link_phone( int $user_id, string $phone ): void {
		global $wpdb;
		$now = current_time( 'mysql' );
		$wpdb->replace(
			$wpdb->prefix . 'bc_phone_index',
			[ 'user_id' => $user_id, 'phone_canonical' => $phone, 'verified_at' => $now, 'created_at' => $now ],
			[ '%d', '%s', '%s', '%s' ]
		);
	}

	public function test_forget_anonymizes_the_user_and_marks_it_deleted(): void {
		$user_id = self::factory()->user->create( [ 'display_name' => 'Real Name', 'user_email' => 'real@example.test' ] );
		update_user_meta( $user_id, '_billing_phone', '09121234567' );

		( new AccountEraser() )->forget( $user_id );

		$user = get_userdata( $user_id );
		$this->assertNotFalse( $user );
		$this->assertSame( 'کاربر حذف‌شده', $user->display_name );
		$this->assertStringContainsString( 'deleted-user-' . $user_id, $user->user_email );
		$this->assertSame( '', get_user_meta( $user_id, '_billing_phone', true ) );
		$this->assertSame( [], $user->roles, 'Every capability must be stripped from an anonymized account.' );
		$this->assertTrue( ( new AccountEraser() )->is_forgotten( $user_id ) );
	}

	public function test_forget_deletes_the_phone_index_row_so_the_number_can_be_reused(): void {
		$user_id = self::factory()->user->create();
		$this->link_phone( $user_id, '+989121234599' );

		( new AccountEraser() )->forget( $user_id );

		global $wpdb;
		$row = $wpdb->get_var( $wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", '+989121234599' ) );
		$this->assertNull( $row );
	}

	public function test_the_same_phone_after_deletion_creates_a_genuinely_new_account_not_the_old_one(): void {
		$old_user_id = self::factory()->user->create();
		$this->link_phone( $old_user_id, '+989121234588' );
		update_user_meta( $old_user_id, '_billing_phone', '09121234588' );

		( new AccountEraser() )->forget( $old_user_id );

		$result = ( new AccountResolver() )->find_or_create_for_phone( '+989121234588' );

		$this->assertTrue( $result['isNew'] );
		$this->assertNotSame( $old_user_id, $result['userId'], 'A fresh OTP registration with a previously-deleted account\'s phone number must never resurrect the old identity.' );
	}

	public function test_forget_is_idempotent(): void {
		$user_id = self::factory()->user->create();
		$eraser  = new AccountEraser();

		$eraser->forget( $user_id );
		$deleted_at_first = get_user_meta( $user_id, AccountEraser::DELETED_AT_META, true );

		$eraser->forget( $user_id ); // Must not throw, and must not overwrite the original deletion timestamp.

		$this->assertSame( $deleted_at_first, get_user_meta( $user_id, AccountEraser::DELETED_AT_META, true ) );
	}
}
