<?php
declare( strict_types=1 );

namespace BeauClick\Chat;

use BeauClick\Chat\Database\Migrations\CreateChatTables;
use BeauClick\Chat\Rest\ChatController;

final class Plugin {

	private const GROUP = 'beauclick-chat';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function migrations(): array {
		return [ new CreateChatTables() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new ChatController() )->register_routes();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
