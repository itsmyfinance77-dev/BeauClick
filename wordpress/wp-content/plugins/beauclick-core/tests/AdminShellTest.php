<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Admin\Shell\AdminShell;
use WP_UnitTestCase;

final class AdminShellTest extends WP_UnitTestCase {

	protected function tearDown(): void {
		wp_dequeue_style( 'beauclick-admin-shell' );
		wp_deregister_style( 'beauclick-admin-shell' );
		parent::tearDown();
	}

	public function test_enqueues_its_stylesheet_on_a_beauclick_admin_screen(): void {
		AdminShell::maybe_enqueue( 'toplevel_page_beauclick' );
		$this->assertTrue( wp_style_is( 'beauclick-admin-shell', 'enqueued' ) );
	}

	public function test_enqueues_its_stylesheet_on_a_beauclick_submenu_screen(): void {
		AdminShell::maybe_enqueue( 'beauclick_page_beauclick-audit-log' );
		$this->assertTrue( wp_style_is( 'beauclick-admin-shell', 'enqueued' ) );
	}

	public function test_never_enqueues_on_an_unrelated_wp_admin_screen(): void {
		AdminShell::maybe_enqueue( 'edit.php' );
		$this->assertFalse( wp_style_is( 'beauclick-admin-shell', 'enqueued' ) );
	}

	public function test_never_enqueues_on_a_woocommerce_screen(): void {
		AdminShell::maybe_enqueue( 'woocommerce_page_wc-orders' );
		$this->assertFalse( wp_style_is( 'beauclick-admin-shell', 'enqueued' ) );
	}
}
