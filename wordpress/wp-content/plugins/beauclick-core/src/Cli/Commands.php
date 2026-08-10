<?php
declare( strict_types=1 );

namespace BeauClick\Core\Cli;

use BeauClick\Core\Plugin;
use WP_CLI;

/**
 * `wp bc:*` commands. Only registered when WP-CLI is present (Plugin::boot()
 * guards this behind defined('WP_CLI')).
 */
final class Commands {

	public static function register( Plugin $plugin ): void {
		WP_CLI::add_command(
			'bc:migrate',
			static function () use ( $plugin ): void {
				$plugin->migrator()->run_all();
				$groups = implode( ', ', $plugin->migrator()->registered_groups() );
				WP_CLI::success( "Ran pending migrations for: {$groups}" );
			},
			[ 'shortdesc' => 'Run every registered beauclick-* plugin migration that has not been applied yet.' ]
		);

		WP_CLI::add_command(
			'bc:seed',
			static function ( array $args ): void {
				$only = $args[0] ?? null;
				/**
				 * Modules hook this to seed their own reference/demo data
				 * (locations plugin: provinces/cities; marketplace: demo
				 * professionals for local dev, etc). $only lets a single
				 * group opt to run in isolation, e.g. `wp bc:seed locations`.
				 */
				do_action( 'beauclick/seed', $only );
				WP_CLI::success( $only ? "Seeded: {$only}" : 'Seed complete for all registered seeders.' );
			},
			[ 'shortdesc' => 'Seed reference/demo data. Optional arg limits to one group, e.g. `wp bc:seed locations`.' ]
		);
	}
}
