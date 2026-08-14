<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Roles\RoleManager;
use WP_UnitTestCase;

/**
 * Regression coverage for a bug a live admin-UI verification pass caught:
 * add_role() silently no-ops when the role already exists, so a capability
 * added to RoleManager's professional/business/admin capability lists
 * after a role's first creation never reached it even on a later
 * register() call — an admin with bc_manage_platform was denied editing
 * bc_professional posts because edit_others_bc_professionals had never
 * actually been granted to the (already-existing) administrator role.
 */
final class RoleManagerTest extends WP_UnitTestCase {

	public function test_register_grants_a_newly_added_capability_onto_an_already_existing_custom_role(): void {
		RoleManager::register();

		// Simulate the exact failure mode: the role already exists (as it
		// would in any real, previously-activated install) but is missing a
		// capability that only exists in the current code.
		$role = get_role( RoleManager::ROLE_PROFESSIONAL );
		$role->remove_cap( 'bc_manage_own_services' );
		$this->assertFalse( $role->has_cap( 'bc_manage_own_services' ) );

		RoleManager::register();

		$this->assertTrue( get_role( RoleManager::ROLE_PROFESSIONAL )->has_cap( 'bc_manage_own_services' ), 'register() must re-grant capabilities onto a role that already exists, not just at first creation.' );
	}

	public function test_register_grants_administrator_capabilities_even_when_the_role_predates_them(): void {
		RoleManager::register();

		$admin = get_role( 'administrator' );
		$admin->remove_cap( 'edit_others_bc_professionals' );
		$this->assertFalse( $admin->has_cap( 'edit_others_bc_professionals' ) );

		RoleManager::register();

		$this->assertTrue( get_role( 'administrator' )->has_cap( 'edit_others_bc_professionals' ) );
	}

	public function test_maybe_register_is_a_noop_when_already_up_to_date(): void {
		RoleManager::maybe_register();

		$role = get_role( RoleManager::ROLE_PROFESSIONAL );
		$role->remove_cap( 'bc_manage_own_services' );

		// The version option is already current from the call above — a
		// second maybe_register() must skip register() entirely and leave
		// the just-removed capability removed.
		RoleManager::maybe_register();

		$this->assertFalse( get_role( RoleManager::ROLE_PROFESSIONAL )->has_cap( 'bc_manage_own_services' ), 'maybe_register() must not re-run register() when the stored version already matches.' );
	}

	/**
	 * V2.2 Step 13: RoleManager::ROLE_PLATFORM_OPERATOR exists specifically
	 * so BeauClick operations staff can reach every bc_manage_platform-gated
	 * admin page without being a full WordPress Administrator.
	 */
	public function test_register_creates_the_platform_operator_role_with_manage_platform_and_read(): void {
		RoleManager::register();

		$role = get_role( RoleManager::ROLE_PLATFORM_OPERATOR );

		$this->assertNotNull( $role );
		$this->assertTrue( $role->has_cap( 'bc_manage_platform' ) );
		$this->assertTrue( $role->has_cap( 'read' ), 'The platform operator role must be able to reach wp-admin at all.' );
	}

	public function test_register_re_grants_capabilities_onto_an_already_existing_platform_operator_role(): void {
		RoleManager::register();

		$role = get_role( RoleManager::ROLE_PLATFORM_OPERATOR );
		$role->remove_cap( 'bc_manage_platform' );
		$this->assertFalse( $role->has_cap( 'bc_manage_platform' ) );

		RoleManager::register();

		$this->assertTrue( get_role( RoleManager::ROLE_PLATFORM_OPERATOR )->has_cap( 'bc_manage_platform' ) );
	}

	public function test_moderator_and_support_roles_can_reach_wp_admin(): void {
		RoleManager::register();

		$this->assertTrue( get_role( RoleManager::ROLE_MODERATOR )->has_cap( 'read' ) );
		$this->assertTrue( get_role( RoleManager::ROLE_SUPPORT )->has_cap( 'read' ) );
	}

	public function test_administrator_still_has_platform_operator_capabilities(): void {
		RoleManager::register();

		$this->assertTrue( get_role( 'administrator' )->has_cap( 'bc_manage_platform' ) );
	}
}
