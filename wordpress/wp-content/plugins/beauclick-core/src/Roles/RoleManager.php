<?php
declare( strict_types=1 );

namespace BeauClick\Core\Roles;

/**
 * Custom roles + granular capabilities for BeauClick.
 *
 * Deliberately few roles (per architecture doc §9 — "don't create roles
 * unnecessarily, use capabilities"): a logged-in shopper stays WooCommerce's
 * own `customer` role (we only add capabilities to it) rather than a
 * duplicate `bc_customer` role. "B2B buyer" is likewise not a role — it's a
 * `bc_business` account whose `wp_bc_business_accounts.approval_status` is
 * `approved`; that's checked at the point of use (pricing/quote code), not
 * synced onto a capability, so approval flips don't need a role rewrite.
 */
final class RoleManager {

	public const ROLE_PROFESSIONAL = 'bc_professional';
	public const ROLE_BUSINESS     = 'bc_business';
	public const ROLE_SUPPORT      = 'bc_support';
	public const ROLE_MODERATOR    = 'bc_moderator';

	/**
	 * Capabilities layered onto every shopper account (WooCommerce's
	 * `customer` role, with a `subscriber` fallback if WooCommerce hasn't
	 * loaded yet — see register()).
	 *
	 * @return string[]
	 */
	public static function customer_capabilities(): array {
		return [ 'bc_book_service', 'bc_write_review', 'bc_use_ai_assistant', 'bc_send_message' ];
	}

	/**
	 * The standard WordPress meta-cap set for "can manage their own posts of
	 * this custom post type, cannot touch anyone else's" — this is what lets
	 * map_meta_cap (set on the CPT registration) do ownership checks for
	 * free in wp-admin. The REST API layer does NOT rely on this — it does
	 * its own explicit ownership checks (RestController::require_owner_or_capability)
	 * — this set exists so wp-admin (used by support/moderator/admin) still
	 * behaves correctly for these post types.
	 *
	 * @return string[]
	 */
	public static function cpt_owner_capabilities( string $singular, string $plural ): array {
		return [
			"edit_{$plural}",
			"edit_{$singular}",
			"edit_published_{$plural}",
			"publish_{$plural}",
			"delete_{$plural}",
			"delete_{$singular}",
			"delete_published_{$plural}",
		];
	}

	/** Additional caps needed to manage OTHER users' posts of a CPT (admin/moderator only). @return string[] */
	public static function cpt_admin_capabilities( string $plural ): array {
		return [ "edit_others_{$plural}", "delete_others_{$plural}", "read_private_{$plural}" ];
	}

	/** @return string[] */
	public static function professional_capabilities(): array {
		return array_merge(
			self::customer_capabilities(),
			[
				'bc_manage_own_profile',
				'bc_manage_own_services',
				'bc_manage_own_availability',
				'bc_view_own_bookings',
				'bc_respond_to_reviews',
			],
			self::cpt_owner_capabilities( 'bc_professional', 'bc_professionals' ),
			self::cpt_owner_capabilities( 'bc_service', 'bc_services' ),
			self::cpt_owner_capabilities( 'bc_portfolio_item', 'bc_portfolio_items' )
		);
	}

	/** @return string[] */
	public static function business_capabilities(): array {
		return array_merge(
			self::professional_capabilities(),
			[
				'bc_manage_business_staff',
				'bc_request_quote',
				'bc_place_bulk_order',
			],
			self::cpt_owner_capabilities( 'bc_business_listing', 'bc_business_listings' )
		);
	}

	/** @return string[] */
	public static function support_capabilities(): array {
		return [ 'bc_view_all_conversations', 'bc_moderate_reviews_limited' ];
	}

	/** @return string[] */
	public static function moderator_capabilities(): array {
		return [ 'bc_moderate_reviews', 'bc_moderate_verification' ];
	}

	/** @return string[] All BeauClick capabilities administrators should implicitly have. */
	public static function admin_capabilities(): array {
		return array_unique(
			array_merge(
				self::business_capabilities(),
				self::support_capabilities(),
				self::moderator_capabilities(),
				self::cpt_admin_capabilities( 'bc_professionals' ),
				self::cpt_admin_capabilities( 'bc_business_listings' ),
				self::cpt_admin_capabilities( 'bc_services' ),
				self::cpt_admin_capabilities( 'bc_portfolio_items' ),
				[ 'bc_manage_platform' ]
			)
		);
	}

	public static function register(): void {
		add_role( self::ROLE_PROFESSIONAL, __( 'Beauty Professional', 'beauclick-core' ), self::as_cap_map( self::professional_capabilities() ) );
		add_role( self::ROLE_BUSINESS, __( 'Business', 'beauclick-core' ), self::as_cap_map( self::business_capabilities() ) );
		add_role( self::ROLE_SUPPORT, __( 'BeauClick Support', 'beauclick-core' ), self::as_cap_map( self::support_capabilities() ) );
		add_role( self::ROLE_MODERATOR, __( 'BeauClick Moderator', 'beauclick-core' ), self::as_cap_map( self::moderator_capabilities() ) );

		self::grant( 'administrator', self::admin_capabilities() );

		// WooCommerce's `customer` role may not exist yet if Woo activates after core;
		// grant onto it when present, and onto `subscriber` as a safe fallback so a
		// Woo-less install still has a working default logged-in role.
		self::grant( 'customer', self::customer_capabilities() );
		self::grant( 'subscriber', self::customer_capabilities() );
	}

	public static function deregister(): void {
		remove_role( self::ROLE_PROFESSIONAL );
		remove_role( self::ROLE_BUSINESS );
		remove_role( self::ROLE_SUPPORT );
		remove_role( self::ROLE_MODERATOR );

		self::revoke( 'administrator', self::admin_capabilities() );
		self::revoke( 'customer', self::customer_capabilities() );
		self::revoke( 'subscriber', self::customer_capabilities() );
	}

	/** @param string[] $caps */
	private static function as_cap_map( array $caps ): array {
		return array_fill_keys( $caps, true );
	}

	/** @param string[] $caps */
	private static function grant( string $role_name, array $caps ): void {
		$role = get_role( $role_name );
		if ( ! $role ) {
			return;
		}
		foreach ( $caps as $cap ) {
			$role->add_cap( $cap );
		}
	}

	/** @param string[] $caps */
	private static function revoke( string $role_name, array $caps ): void {
		$role = get_role( $role_name );
		if ( ! $role ) {
			return;
		}
		foreach ( $caps as $cap ) {
			$role->remove_cap( $cap );
		}
	}
}
