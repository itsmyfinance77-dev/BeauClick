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

	public const ROLE_PROFESSIONAL      = 'bc_professional';
	public const ROLE_BUSINESS          = 'bc_business';
	public const ROLE_SUPPORT           = 'bc_support';
	public const ROLE_MODERATOR         = 'bc_moderator';
	public const ROLE_PLATFORM_OPERATOR = 'bc_platform_operator';

	/**
	 * Bump whenever the capability lists below change. maybe_register()
	 * only does the (several DB-writing) work of register() when this
	 * doesn't match the stored option — a plain `add_action('admin_init',
	 * ...register())` would otherwise re-grant every capability on every
	 * admin page load for every admin, which WP_Role::add_cap() persists
	 * with its own update_option() call each time.
	 *
	 * 2026-08-15.1 (V2.3 Step 19): added 'bc_use_professional_ai' to
	 * professional_capabilities() (and therefore, via array_merge,
	 * business_capabilities() too) — the new professional-facing, read-only
	 * AI insight surface. Deliberately its own capability, not a reuse of
	 * 'bc_use_ai_assistant' (which every customer, including professionals
	 * themselves in their shopper capacity, already holds) — the two
	 * surfaces read from entirely different, differently-scoped data, and
	 * keeping them separately grantable/revocable is the same "don't
	 * conflate two different permissions just because one entity happens to
	 * hold both today" discipline this file already applies elsewhere.
	 *
	 * 2026-08-14.1 (V2.2 Step 13): added ROLE_PLATFORM_OPERATOR — every
	 * BeauClick admin page (B2B, loyalty, notifications, analytics, the new
	 * audit log/operations/users pages) has so far only ever been reachable
	 * by a full WordPress Administrator, since bc_manage_platform was only
	 * ever granted to that role. That's more authority than "run BeauClick
	 * operations" actually needs — a full Administrator can also install
	 * plugins, edit theme/plugin files, and manage every other WP user.
	 * This role holds bc_manage_platform (and 'read', so it can reach
	 * wp-admin at all) without any of that. Also added 'read' to
	 * moderator/support so those roles can reach wp-admin too — both were
	 * previously missing it, a real (if narrow) gap: a user role with no
	 * `read` capability is not guaranteed a working wp-admin session by
	 * WordPress core.
	 */
	private const CAPS_VERSION = '2026-08-15.1';

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
				'bc_use_professional_ai',
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
		return [ 'read', 'bc_view_all_conversations', 'bc_moderate_reviews_limited' ];
	}

	/** @return string[] */
	public static function moderator_capabilities(): array {
		return [ 'read', 'bc_moderate_reviews', 'bc_moderate_verification' ];
	}

	/**
	 * V2.2 Step 13 — a real, wp-admin-usable role for BeauClick operations
	 * staff who need every BeauClick admin surface (overview, audit log,
	 * operations/health, users, B2B, reviews, loyalty, notifications,
	 * analytics — everything gated on bc_manage_platform) without being a
	 * full WordPress Administrator. Deliberately still just
	 * bc_manage_platform, the same single capability every one of those
	 * pages already checks — this role does not introduce any new,
	 * narrower capability, per this step's own "prefer a small,
	 * understandable model" instruction.
	 *
	 * @return string[]
	 */
	public static function platform_operator_capabilities(): array {
		return [ 'read', 'bc_manage_platform' ];
	}

	/** @return string[] All BeauClick capabilities administrators should implicitly have. */
	public static function admin_capabilities(): array {
		return array_unique(
			array_merge(
				self::business_capabilities(),
				self::support_capabilities(),
				self::moderator_capabilities(),
				self::platform_operator_capabilities(),
				self::cpt_admin_capabilities( 'bc_professionals' ),
				self::cpt_admin_capabilities( 'bc_business_listings' ),
				self::cpt_admin_capabilities( 'bc_services' ),
				self::cpt_admin_capabilities( 'bc_portfolio_items' ),
				[ 'bc_manage_platform' ]
			)
		);
	}

	/** Cheap in the common case (one autoloaded get_option() call) — see CAPS_VERSION. */
	public static function maybe_register(): void {
		if ( get_option( 'bc_roles_caps_version' ) === self::CAPS_VERSION ) {
			return;
		}
		self::register();
		update_option( 'bc_roles_caps_version', self::CAPS_VERSION );
	}

	public static function register(): void {
		self::ensure_role( self::ROLE_PROFESSIONAL, __( 'Beauty Professional', 'beauclick-core' ), self::professional_capabilities() );
		self::ensure_role( self::ROLE_BUSINESS, __( 'Business', 'beauclick-core' ), self::business_capabilities() );
		self::ensure_role( self::ROLE_SUPPORT, __( 'BeauClick Support', 'beauclick-core' ), self::support_capabilities() );
		self::ensure_role( self::ROLE_MODERATOR, __( 'BeauClick Moderator', 'beauclick-core' ), self::moderator_capabilities() );
		self::ensure_role( self::ROLE_PLATFORM_OPERATOR, __( 'BeauClick Platform Operator', 'beauclick-core' ), self::platform_operator_capabilities() );

		self::grant( 'administrator', self::admin_capabilities() );

		// WooCommerce's `customer` role may not exist yet if Woo activates after core;
		// grant onto it when present, and onto `subscriber` as a safe fallback so a
		// Woo-less install still has a working default logged-in role.
		self::grant( 'customer', self::customer_capabilities() );
		self::grant( 'subscriber', self::customer_capabilities() );
	}

	/**
	 * add_role() silently no-ops if the role already exists — a capability
	 * added to professional_capabilities()/business_capabilities()/etc.
	 * after a role's first creation would otherwise never reach it, even on
	 * every subsequent register() call. grant()-ing onto the existing role
	 * instead makes register() a true "bring capabilities up to date"
	 * operation, safe to call repeatedly (see Plugin::boot()'s admin_init
	 * hook, gated on CAPS_VERSION so this stays cheap in the common case).
	 *
	 * @param string[] $caps
	 */
	private static function ensure_role( string $role_name, string $display_name, array $caps ): void {
		if ( get_role( $role_name ) ) {
			self::grant( $role_name, $caps );
			return;
		}
		add_role( $role_name, $display_name, self::as_cap_map( $caps ) );
	}

	public static function deregister(): void {
		remove_role( self::ROLE_PROFESSIONAL );
		remove_role( self::ROLE_BUSINESS );
		remove_role( self::ROLE_SUPPORT );
		remove_role( self::ROLE_MODERATOR );
		remove_role( self::ROLE_PLATFORM_OPERATOR );

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
