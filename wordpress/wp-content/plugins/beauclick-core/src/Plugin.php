<?php
declare( strict_types=1 );

namespace BeauClick\Core;

use BeauClick\Core\Database\Migrator;
use BeauClick\Core\Database\Migrations\CreateEventsTable;
use BeauClick\Core\Roles\RoleManager;
use BeauClick\Core\Support\ServiceContainer;
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
		add_action( 'rest_api_init', [ $this, 'register_rest_routes' ] );

		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			Commands::register( $this );
		}
	}

	private function register_services(): void {
		$this->container->set( 'migrator', static fn () => new Migrator() );
		$this->container->set( 'events', static fn () => new EventLogger() );

		// Core's own migrations register immediately; dependent plugins hook
		// `beauclick/core/register_migrations` at default priority (10) to
		// register theirs onto the same Migrator instance.
		$this->migrator()->register( 'beauclick-core', [ new CreateEventsTable() ] );

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

		$instance = self::instance();
		$instance->register_services();
		$instance->migrator()->run_group( 'beauclick-core' );

		flush_rewrite_rules();
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
