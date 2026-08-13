<?php
declare( strict_types=1 );

namespace BeauClick\Notifications;

use BeauClick\Notifications\Admin\NotificationsAdminPage;
use BeauClick\Notifications\Cron\RetrySweepScheduler;
use BeauClick\Notifications\Database\Migrations\CreateNotificationTables;
use BeauClick\Notifications\Rest\NotificationsController;

final class Plugin {

	private const GROUP = 'beauclick-notifications';

	private static ?Plugin $instance = null;

	private NotificationService $service;

	private function __construct() {
		$this->service = new NotificationService();
	}

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function service(): NotificationService {
		return $this->service;
	}

	private function migrations(): array {
		return [ new CreateNotificationTables() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );

		$retry_scheduler = new RetrySweepScheduler();
		$retry_scheduler->register();
		add_action( 'admin_init', [ $retry_scheduler, 'ensure_scheduled' ] );

		( new NotificationsAdminPage() )->register();
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new NotificationsController() )->register_routes();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );

		( new RetrySweepScheduler() )->ensure_scheduled();
	}

	public static function deactivate(): void {
		( new RetrySweepScheduler() )->unschedule();
	}
}
