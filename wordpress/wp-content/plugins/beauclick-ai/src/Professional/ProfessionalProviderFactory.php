<?php
declare( strict_types=1 );

namespace BeauClick\AI\Professional;

use BeauClick\AI\ProviderInterface;

/**
 * Mirrors `BeauClick\AI\ProviderFactory` exactly — same env vars
 * (BC_AI_PROVIDER/BC_AI_API_KEY/BC_AI_MODEL), so a single provider
 * configuration serves both customer and professional AI (task §20: "do not
 * build a second AI provider system"). Only the concrete classes differ,
 * because the two modes need different system prompts / response shapes
 * (see ProfessionalAnthropicProvider's own docblock for why that isn't a
 * simple parameter on the existing customer-mode classes).
 *
 * Deliberately not `final`, matching ProviderFactory's own reasoning — the
 * one collaborator a future test may need to substitute.
 */
class ProfessionalProviderFactory {

	public function make(): ProviderInterface {
		$provider = function_exists( 'bc_env' ) ? bc_env( 'BC_AI_PROVIDER' ) : '';
		$api_key  = function_exists( 'bc_env' ) ? bc_env( 'BC_AI_API_KEY' ) : '';

		if ( 'anthropic' === $provider && '' !== $api_key ) {
			$model = bc_env( 'BC_AI_MODEL', 'claude-sonnet-5' );
			return new ProfessionalAnthropicProvider( $api_key, $model );
		}

		return new ProfessionalRuleBasedProvider();
	}
}
