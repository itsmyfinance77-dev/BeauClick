<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Admin\UsersAdminPage;
use WP_UnitTestCase;

final class UsersAdminPageTest extends WP_UnitTestCase {

	public function test_registers_a_submenu_under_the_beauclick_parent(): void {
		global $submenu;

		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		( new UsersAdminPage() )->add_page();

		$slugs = array_column( $submenu['beauclick'] ?? [], 2 );
		$this->assertContains( 'beauclick-users', $slugs );
	}

	public function test_render_denies_a_user_without_bc_manage_platform(): void {
		$customer_id = self::factory()->user->create( [ 'role' => 'subscriber' ] );
		wp_set_current_user( $customer_id );

		$this->expectException( \WPDieException::class );
		( new UsersAdminPage() )->render();
	}

	public function test_render_masks_the_phone_number_and_never_prints_it_in_full(): void {
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		$target = self::factory()->user->create( [ 'role' => 'customer', 'display_name' => 'Test Customer' ] );
		update_user_meta( $target, '_billing_phone', '09121234567' );

		$_GET['s'] = 'Test Customer';

		ob_start();
		( new UsersAdminPage() )->render();
		$output = ob_get_clean();
		unset( $_GET['s'] );

		$this->assertStringNotContainsString( '09121234567', $output, 'The full phone number must never be printed.' );
		$this->assertStringContainsString( '***', $output );
	}

	public function test_search_finds_a_user_by_phone_number_even_when_name_does_not_match(): void {
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		$target = self::factory()->user->create( [ 'role' => 'customer', 'display_name' => 'Unrelated Name' ] );
		update_user_meta( $target, '_billing_phone', '09359998877' );

		$_GET['s'] = '09359998877';

		ob_start();
		( new UsersAdminPage() )->render();
		$output = ob_get_clean();
		unset( $_GET['s'] );

		$this->assertStringContainsString( 'Unrelated Name', $output );
	}
}
