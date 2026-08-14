<?php
declare( strict_types=1 );

namespace BeauClick\Privacy;

use BeauClick\Privacy\Admin\PrivacyRequestsPage;
use BeauClick\Privacy\Database\Migrations\CreateDataRequestsTable;
use BeauClick\Privacy\Deletion\DeletionScheduler;
use BeauClick\Privacy\Export\ExportCleanupScheduler;
use BeauClick\Privacy\Rest\PrivacyController;

final class Plugin {

	private const GROUP = 'beauclick-privacy';

	private static ?Plugin $instance = null;

	private DeletionScheduler $deletion_scheduler;
	private ExportCleanupScheduler $export_cleanup_scheduler;

	private function __construct() {
		$this->deletion_scheduler       = new DeletionScheduler();
		$this->export_cleanup_scheduler = new ExportCleanupScheduler();
	}

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function migrations(): array {
		return [ new CreateDataRequestsTable() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );

		$this->deletion_scheduler->register();
		$this->export_cleanup_scheduler->register();
		add_action( 'admin_init', [ $this, 'ensure_scheduled' ] ); // Same "re-arm defensively" pattern as RoleManager::maybe_register() -- a schedule can be lost (e.g. after a migration/restore) without this ever failing loudly on its own.

		( new PrivacyRequestsPage() )->register();
	}

	public function ensure_scheduled(): void {
		$this->deletion_scheduler->ensure_scheduled();
		$this->export_cleanup_scheduler->ensure_scheduled();
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new PrivacyController() )->register_routes();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
		self::instance()->ensure_scheduled();
	}

	public static function deactivate(): void {
		self::instance()->deletion_scheduler->unschedule();
		self::instance()->export_cleanup_scheduler->unschedule();
	}
}
