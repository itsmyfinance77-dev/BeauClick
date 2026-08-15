<?php
declare( strict_types=1 );

namespace BeauClick\AI;

use BeauClick\AI\Database\Migrations\CreateAiProfessionalTables;
use BeauClick\AI\Database\Migrations\CreateAiTables;
use BeauClick\AI\Rest\AssistantController;
use BeauClick\AI\Rest\ProfessionalAssistantController;

final class Plugin {

	private const GROUP = 'beauclick-ai';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function migrations(): array {
		return [ new CreateAiTables(), new CreateAiProfessionalTables() ];
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
		( new AssistantController() )->register_routes();
		( new ProfessionalAssistantController() )->register_routes();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
