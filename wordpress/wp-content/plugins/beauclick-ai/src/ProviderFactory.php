<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * The one place that knows BC_AI_PROVIDER/BC_AI_API_KEY exist — everything
 * else in the plugin depends only on ProviderInterface. Falls back to
 * RuleBasedProvider whenever a real provider isn't fully configured, rather
 * than erroring, so the assistant stays usable with zero setup.
 *
 * Deliberately not `final`: it's the one collaborator AssistantServiceTest
 * needs to substitute (via PHPUnit's mock, which subclasses it) to prove a
 * hallucinated recommendation ID gets dropped regardless of which provider
 * produced it, without making an real/fake HTTP call in a unit test.
 */
class ProviderFactory {

	public function make(): ProviderInterface {
		$provider = function_exists( 'bc_env' ) ? bc_env( 'BC_AI_PROVIDER' ) : '';
		$api_key  = function_exists( 'bc_env' ) ? bc_env( 'BC_AI_API_KEY' ) : '';

		if ( 'anthropic' === $provider && '' !== $api_key ) {
			$model = bc_env( 'BC_AI_MODEL', 'claude-sonnet-5' );
			return new AnthropicProvider( $api_key, $model );
		}

		return new RuleBasedProvider();
	}
}
