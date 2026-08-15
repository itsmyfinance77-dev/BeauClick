<?php
declare( strict_types=1 );

namespace BeauClick\Core;

use BeauClick\Core\Admin\AdminMenu;
use BeauClick\Core\Admin\AuditLogPage;
use BeauClick\Core\Admin\OperationsHealthPage;
use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Admin\UsersAdminPage;
use BeauClick\Core\Content\ContactFormHandler;
use BeauClick\Core\Content\LegalPages;
use BeauClick\Core\Database\Migrator;
use BeauClick\Core\Database\Migrations\CreateAdminAuditLogTable;
use BeauClick\Core\Database\Migrations\CreateEventsTable;
use BeauClick\Core\Roles\RoleManager;
use BeauClick\Core\Support\ServiceContainer;
use BeauClick\Core\Support\AuditLogger;
use BeauClick\Core\Support\EventLogger;
use BeauClick\Core\Support\Tokens;
use BeauClick\Core\Cli\Commands;

/**
 * Bootstrap + shared service locator for beauclick-core. Other plugins reach
 * shared services through the global beauclick_core() helper (declared at
 * the bottom of this file) rather than instantiating their own copies —
 * e.g. beauclick_core()->events()->log(...), beauclick_core()->migrator().
 */
final class Plugin {

	private static ?Plugin $instance = null;

	private ServiceContainer $container;

	private function __construct() {
		$this->container = new ServiceContainer();
	}

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function boot(): void {
		$this->register_services();

		add_action( 'init', [ $this, 'load_textdomain' ] );
		add_action( 'wp_enqueue_scripts', [ $this, 'enqueue_design_tokens' ] );
		add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_design_tokens' ] );
		// wp-login.php never loads wp_enqueue_scripts (only login_enqueue_scripts)
		// — needed so the theme's login.css (inc/branding.php) can use the same
		// --bc-* custom properties as every other BeauClick-branded surface.
		add_action( 'login_enqueue_scripts', [ $this, 'enqueue_design_tokens' ] );
		add_action( 'rest_api_init', [ $this, 'register_rest_routes' ] );

		/**
		 * Defensive re-grant, same "re-arm on admin_init" pattern as
		 * HoldExpiryScheduler::ensure_scheduled(). A role's capabilities are
		 * a snapshot written to the DB at whatever point register() last
		 * ran (normally only Plugin::activate()) — not read live from
		 * RoleManager's code — so any capability added to RoleManager since
		 * then silently never reaches an already-existing role. Caught
		 * live: an admin account had bc_manage_platform but was denied
		 * editing bc_professional posts because edit_others_bc_professionals
		 * wasn't in the admin role's actual stored capability set.
		 * maybe_register() keeps this cheap (CAPS_VERSION-gated) rather than
		 * re-granting on literally every admin page load.
		 */
		add_action( 'admin_init', [ RoleManager::class, 'maybe_register' ] );
		add_action( 'admin_init', [ LegalPages::class, 'maybe_ensure' ] );

		AdminShell::register();
		( new AdminMenu() )->register();
		( new OperationsHealthPage() )->register();
		( new AuditLogPage() )->register();
		( new UsersAdminPage() )->register();
		ContactFormHandler::register();

		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			Commands::register( $this );
		}
	}

	private function register_services(): void {
		$this->container->set( 'migrator', static fn () => new Migrator() );
		$this->container->set( 'events', static fn () => new EventLogger() );
		$this->container->set( 'audit_log', static fn () => new AuditLogger() );

		// Core's own migrations register immediately; dependent plugins hook
		// `beauclick/core/register_migrations` at default priority (10) to
		// register theirs onto the same Migrator instance.
		$this->migrator()->register( 'beauclick-core', [ new CreateEventsTable(), new CreateAdminAuditLogTable() ] );

		add_action(
			'plugins_loaded',
			function (): void {
				do_action( 'beauclick/core/register_migrations', $this->migrator() );
			},
			5
		);
	}

	public function migrator(): Migrator {
		return $this->container->get( 'migrator' );
	}

	public function events(): EventLogger {
		return $this->container->get( 'events' );
	}

	public function audit_log(): AuditLogger {
		return $this->container->get( 'audit_log' );
	}

	public function container(): ServiceContainer {
		return $this->container;
	}

	public function load_textdomain(): void {
		load_plugin_textdomain( 'beauclick-core', false, dirname( plugin_basename( BEAUCLICK_CORE_FILE ) ) . '/languages' );
	}

	/**
	 * Design tokens as CSS custom properties on :root, generated from
	 * shared/design-tokens.json — the single cross-stack source of truth.
	 * Registered as a standalone stylesheet so both the theme and admin UI
	 * (and, indirectly, any React island reading computed styles) see the
	 * same values without each plugin/theme re-declaring them.
	 */
	public function enqueue_design_tokens(): void {
		$css = Tokens::to_css();
		if ( '' === $css ) {
			return;
		}
		wp_register_style( 'beauclick-tokens', false, [], BEAUCLICK_CORE_VERSION );
		wp_enqueue_style( 'beauclick-tokens' );
		wp_add_inline_style( 'beauclick-tokens', $css );
	}

	public function register_rest_routes(): void {
		do_action( 'beauclick/core/register_rest_routes' );
	}

	public static function activate(): void {
		Migrator::install_ledger();
		RoleManager::register();
		self::ensure_site_timezone();
		self::ensure_site_locale();

		$instance = self::instance();
		$instance->register_services();
		$instance->migrator()->run_group( 'beauclick-core' );

		flush_rewrite_rules();
	}

	/**
	 * A production-readiness audit found the site locale had never been
	 * set — every page rendered its own Persian content correctly (all
	 * hand-authored theme/plugin strings), but WordPress core's and
	 * WooCommerce's OWN translated strings (checkout form labels,
	 * "Place order", country/state dropdown, admin screens) were all still
	 * in English, since WordPress defaults to en_US until told otherwise.
	 * This only sets the *option* — it does not download the fa_IR
	 * translation files themselves (that needs network access at a time
	 * that may not be activation, and `wp language core install fa_IR
	 * --activate` / `wp language plugin install woocommerce fa_IR` is the
	 * standard, safer way to provision that once per environment); setting
	 * WPLANG ahead of the files being present is harmless — WordPress just
	 * falls back to English until they exist. Never overwrites a
	 * deliberately-chosen locale.
	 */
	private static function ensure_site_locale(): void {
		if ( '' === get_option( 'WPLANG' ) ) {
			update_option( 'WPLANG', 'fa_IR' );
		}
	}

	/**
	 * Not the same thing as the architecture doc's "never hard-code Tehran"
	 * rule — that rule is about not defaulting *business* data (a user's
	 * city, search results, demo content) to one launch city. A timezone is
	 * a genuine platform-wide setting: Iran has a single zone nationwide
	 * (UTC+3:30, no DST), so "Asia/Tehran" is correct for every city
	 * BeauClick ever launches in, not a Tehran-specific assumption. Left
	 * unset, WordPress defaults to UTC, which a production-readiness audit
	 * found several booking-availability date comparisons silently assumed
	 * was already correct. Only sets it if still WordPress's own blank
	 * default — never overwrites a value an admin deliberately changed.
	 */
	private static function ensure_site_timezone(): void {
		if ( '' === get_option( 'timezone_string' ) && 0.0 === (float) get_option( 'gmt_offset' ) ) {
			update_option( 'timezone_string', 'Asia/Tehran' );
		}
	}

	public static function deactivate(): void {
		flush_rewrite_rules();
		// Roles are intentionally left in place on deactivation (not just
		// deregistered) so temporarily disabling the plugin (e.g. during an
		// update) doesn't strip capabilities from every professional/business
		// account. RoleManager::deregister() is only ever called from an
		// explicit uninstall.php, never from deactivate().
	}
}
