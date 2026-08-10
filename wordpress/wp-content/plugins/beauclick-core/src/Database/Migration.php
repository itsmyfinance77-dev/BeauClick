<?php
declare( strict_types=1 );

namespace BeauClick\Core\Database;

/**
 * One schema change. Implementations must be idempotent — dbDelta() already is,
 * so migrations built around dbDelta are safe to re-run; migrations doing
 * anything else (data backfills, index changes not supported by dbDelta) must
 * guard themselves (e.g. check information_schema before altering).
 */
interface Migration {

	/**
	 * Stable identifier, unique within the migration's group (plugin slug).
	 * Never change this once shipped — it's the ledger key that marks the
	 * migration as applied.
	 */
	public function id(): string;

	public function up(): void;
}
