<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Admin\OperationsHealthPage;
use WP_UnitTestCase;

final class OperationsHealthPageTest extends WP_UnitTestCase {

	public function test_registers_a_submenu_under_the_beauclick_parent(): void {
		global $submenu;

		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		( new OperationsHealthPage() )->add_page();

		$slugs = array_column( $submenu['beauclick'] ?? [], 2 );
		$this->assertContains( 'beauclick-operations', $slugs );
	}

	public function test_render_denies_a_user_without_bc_manage_platform(): void {
		$customer_id = self::factory()->user->create( [ 'role' => 'subscriber' ] );
		wp_set_current_user( $customer_id );

		$this->expectException( \WPDieException::class );
		( new OperationsHealthPage() )->render();
	}

	public function test_render_succeeds_for_a_user_with_bc_manage_platform(): void {
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		ob_start();
		( new OperationsHealthPage() )->render();
		$output = ob_get_clean();

		$this->assertStringContainsString( 'عملیات و سلامت', $output );
		$this->assertStringNotContainsString( 'ZARINPAL', $output, 'The page must never print a raw secret/credential value.' );
	}
}
