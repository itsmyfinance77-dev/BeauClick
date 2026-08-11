<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * No vendor is hardcoded into calling code — AssistantService only ever
 * talks to this interface (architecture doc §16). Swapping providers is a
 * ProviderFactory config change, not a rewrite of the REST layer, the
 * database shape, or the frontend.
 */
interface ProviderInterface {

	/**
	 * @param array<int, array{role: string, content: string}> $history Oldest first, including the just-added user message.
	 * @param array<string, mixed>                              $context Structured signals accumulated so far (skinType, hairType, budget, cityId, ...).
	 */
	public function chat( array $history, array $context ): AssistantResponse;
}
