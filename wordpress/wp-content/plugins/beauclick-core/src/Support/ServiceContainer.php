<?php
declare( strict_types=1 );

namespace BeauClick\Core\Support;

/**
 * Minimal array-backed service container. Deliberately not a full DI framework —
 * BeauClick's modules are few and their dependencies are simple; a heavier
 * container would be complexity the project doesn't need yet.
 */
final class ServiceContainer {

	/** @var array<string, mixed> */
	private array $instances = [];

	/** @var array<string, callable> */
	private array $factories = [];

	public function set( string $id, callable $factory ): void {
		$this->factories[ $id ] = $factory;
		unset( $this->instances[ $id ] );
	}

	public function get( string $id ): mixed {
		if ( ! array_key_exists( $id, $this->instances ) ) {
			if ( ! isset( $this->factories[ $id ] ) ) {
				throw new \RuntimeException( sprintf( 'BeauClick service "%s" is not registered.', $id ) );
			}
			$this->instances[ $id ] = ( $this->factories[ $id ] )( $this );
		}

		return $this->instances[ $id ];
	}

	public function has( string $id ): bool {
		return isset( $this->factories[ $id ] );
	}
}
