<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * The only genuinely new CRM data (architecture doc §4.5 — "most of CRM is
 * a view over existing booking/review/chat data plus a small amount of
 * genuinely new data: notes, tags"). Everything else the CRM surfaces
 * (customer list, booking history, reviews, conversation summary) is
 * composed at read time from tables that already exist — see CrmService.
 *
 * Keyed by provider_id (the bc_professional/bc_business CPT post id), not
 * author_user_id — this matches every other ownership boundary in this
 * codebase (bookings/reviews are both keyed by provider_id, resolved from
 * the current WP user via ProviderLookup::for_user()). author_user_id is
 * still recorded for display/audit ("who on this team wrote this"), but the
 * actual access-control check is always provider_id === the caller's own
 * resolved provider.
 *
 * No cross-plugin FK to wp_bc_bookings/wp_posts, matching every other table
 * in this codebase (WordPress doesn't guarantee plugin activation order).
 */
final class CreateCrmNotesTable implements Migration {

	public function id(): string {
		return '2026_08_12_create_crm_notes_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_crm_notes (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				provider_id BIGINT UNSIGNED NOT NULL,
				customer_id BIGINT UNSIGNED NOT NULL,
				author_user_id BIGINT UNSIGNED NOT NULL,
				note VARCHAR(2000) NOT NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY provider_customer (provider_id, customer_id, created_at)
			) {$charset_collate};"
		);
	}
}
