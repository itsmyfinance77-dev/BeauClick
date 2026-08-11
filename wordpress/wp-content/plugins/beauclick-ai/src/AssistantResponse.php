<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * A provider's raw output. `recommendations` are the provider's OWN claims
 * about which catalog IDs it means — AssistantService::send() re-validates
 * every one against real DB rows before anything is persisted or rendered
 * (architecture doc §8/§16: "never trust the model's IDs blindly"), so a
 * provider adapter is free to be wrong here without that ever reaching a user.
 */
final class AssistantResponse {

	/**
	 * @param array<int, array{type: string, id: int}> $recommendations
	 * @param array<string, mixed>                      $contextUpdates Merged into the conversation's stored ai_context.
	 */
	public function __construct(
		public readonly string $reply,
		public readonly array $recommendations = [],
		public readonly array $contextUpdates = []
	) {
	}
}
