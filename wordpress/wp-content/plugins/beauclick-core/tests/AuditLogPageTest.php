<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Admin\AuditLogPage;
use BeauClick\Core\Support\AuditLogger;
use WP_UnitTestCase;

final class AuditLogPageTest extends WP_UnitTestCase {

	public function test_registers_a_submenu_under_the_beauclick_parent(): void {
		global $submenu;

		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		( new AuditLogPage() )->add_page();

		$slugs = array_column( $submenu['beauclick'] ?? [], 2 );
		$this->assertContains( 'beauclick-audit-log', $slugs );
	}

	public function test_render_denies_a_user_without_bc_manage_platform(): void {
		$customer_id = self::factory()->user->create( [ 'role' => 'subscriber' ] );
		wp_set_current_user( $customer_id );

		$this->expectException( \WPDieException::class );
		( new AuditLogPage() )->render();
	}

	public function test_render_lists_entries_from_both_the_audit_log_and_verification_history(): void {
		global $wpdb;

		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		( new AuditLogger() )->record( 'b2b_account_approved', 'business_account', 1, $admin_id );

		$wpdb->insert(
			$wpdb->prefix . 'bc_verification_history',
			[
				'provider_id'    => 5,
				'request_id'     => null,
				'from_status'    => 'pending',
				'to_status'      => 'verified',
				'actor_user_id'  => $admin_id,
				'reason'         => null,
				'created_at'     => current_time( 'mysql' ),
			]
		);

		ob_start();
		( new AuditLogPage() )->render();
		$output = ob_get_clean();

		$this->assertStringContainsString( 'تأیید حساب B2B', $output );
		$this->assertStringContainsString( 'تأیید متخصص/کسب‌وکار', $output );
	}

	public function test_label_falls_back_to_the_raw_action_type_for_an_unknown_action(): void {
		$this->assertSame( 'some_future_action', AuditLogPage::label( 'some_future_action' ) );
	}
}
