<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Admin\AdminMenu;
use WP_UnitTestCase;

/**
 * WordPress's own menu-building (wp-admin/includes/menu.php) auto-promotes
 * whichever submenu happens to register FIRST under a top-level parent into
 * that parent's effective landing page -- unless the parent explicitly
 * registers its own submenu with a slug matching its own. Without that, a
 * live verification pass found every OTHER beauclick-* module's admin page
 * (B2B account approvals, review moderation) could 403 an admin who
 * genuinely has the required capability, purely depending on plugin load
 * order -- user_can_access_admin_page() ends up looking up a hookname
 * computed against a DIFFERENT (promoted) parent than the one the page was
 * actually registered under.
 */
final class AdminMenuTest extends WP_UnitTestCase {

	public function test_the_beauclick_parent_menu_has_a_self_referencing_submenu(): void {
		global $submenu;

		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		( new AdminMenu() )->add_menu();

		$this->assertArrayHasKey( 'beauclick', $submenu ?? [], 'The parent menu must register at least one submenu.' );
		$self_entries = array_filter( $submenu['beauclick'] ?? [], static fn ( array $item ) => 'beauclick' === $item[2] );
		$this->assertNotEmpty(
			$self_entries,
			"The 'beauclick' parent menu must register its OWN slug as a submenu entry, or WordPress's menu-building silently promotes whichever OTHER module's submenu registers first into the parent's landing page -- breaking that submenu's permission-hook lookup regardless of the admin's actual capabilities."
		);
	}

	public function test_register_hooks_add_menu_ahead_of_every_other_modules_default_priority(): void {
		$admin_menu = new AdminMenu();
		$admin_menu->register();

		$this->assertSame(
			5,
			has_action( 'admin_menu', [ $admin_menu, 'add_menu' ] ),
			"Must run before every other beauclick-* module's own admin_menu-hooked add_submenu_page( 'beauclick', ... ) call (all at the WordPress default priority 10) -- otherwise this parent's self-referencing submenu might not be the first one registered, and the promotion bug can resurface regardless of plugin activation order."
		);
	}
}
