<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\AnthropicProvider;
use WP_UnitTestCase;

/**
 * The live HTTP round trip to api.anthropic.com is not exercised here (no
 * real key in this environment -- see AnthropicProvider's own docblock);
 * what IS fully testable and tested is the adapter's own contract: it must
 * degrade gracefully on any failure or malformed output, and must never
 * throw a fatal error out of chat(), regardless of what the remote API
 * returns.
 */
final class AnthropicProviderTest extends WP_UnitTestCase {

	private $filter;

	protected function tearDown(): void {
		if ( $this->filter ) {
			remove_filter( 'pre_http_request', $this->filter );
			$this->filter = null;
		}
		parent::tearDown();
	}

	private function mock_http_response( array $response ): void {
		$this->filter = static fn () => $response;
		add_filter( 'pre_http_request', $this->filter, 10, 3 );
	}

	public function test_a_well_formed_json_reply_is_parsed_into_a_response_with_recommendations(): void {
		$this->mock_http_response(
			[
				'response' => [ 'code' => 200 ],
				'body'     => wp_json_encode(
					[
						'content' => [
							[
								'text' => wp_json_encode(
									[
										'reply'           => 'این چند گزینه واقعی رو برات پیدا کردم.',
										'recommendations' => [ [ 'type' => 'product', 'id' => 42, 'reason' => 'مرتبط با درخواستت' ] ],
										'context_updates' => [ 'budget' => 500000 ],
									]
								),
							],
						],
					]
				),
			]
		);

		$provider = new AnthropicProvider( 'fake-key', 'claude-sonnet-5' );
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'سلام' ] ], [] );

		$this->assertSame( 'این چند گزینه واقعی رو برات پیدا کردم.', $response->reply );
		$this->assertSame( [ [ 'type' => 'product', 'id' => 42, 'reason' => 'مرتبط با درخواستت' ] ], $response->recommendations );
		$this->assertSame( [ 'budget' => 500000 ], $response->contextUpdates );
	}

	public function test_a_non_json_reply_degrades_to_plain_text_with_no_recommendations(): void {
		$this->mock_http_response(
			[
				'response' => [ 'code' => 200 ],
				'body'     => wp_json_encode( [ 'content' => [ [ 'text' => 'این یک متن ساده غیر جیسون است' ] ] ] ),
			]
		);

		$provider = new AnthropicProvider( 'fake-key', 'claude-sonnet-5' );
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'سلام' ] ], [] );

		$this->assertSame( 'این یک متن ساده غیر جیسون است', $response->reply );
		$this->assertSame( [], $response->recommendations );
	}

	public function test_a_recommendation_missing_required_keys_is_dropped_not_fatal(): void {
		$this->mock_http_response(
			[
				'response' => [ 'code' => 200 ],
				'body'     => wp_json_encode(
					[
						'content' => [
							[
								'text' => wp_json_encode(
									[
										'reply'           => 'باشه',
										'recommendations' => [ [ 'type' => 'product' ], [ 'id' => 7 ], [ 'type' => 'product', 'id' => 9 ] ],
									]
								),
							],
						],
					]
				),
			]
		);

		$provider = new AnthropicProvider( 'fake-key', 'claude-sonnet-5' );
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'سلام' ] ], [] );

		$this->assertCount( 1, $response->recommendations, 'Malformed recommendation entries (missing type or id) must be silently dropped, never fatal.' );
		$this->assertSame( 9, $response->recommendations[0]['id'] );
	}

	public function test_an_http_error_degrades_to_a_retry_later_reply_not_an_exception(): void {
		$this->mock_http_response( [ 'response' => [ 'code' => 500 ], 'body' => '' ] );

		$provider = new AnthropicProvider( 'fake-key', 'claude-sonnet-5' );
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'سلام' ] ], [] );

		$this->assertSame( [], $response->recommendations );
		$this->assertNotSame( '', trim( $response->reply ) );
	}

	public function test_a_wp_error_from_the_transport_degrades_gracefully(): void {
		$this->filter = static fn () => new \WP_Error( 'http_request_failed', 'timeout' );
		add_filter( 'pre_http_request', $this->filter, 10, 3 );

		$provider = new AnthropicProvider( 'fake-key', 'claude-sonnet-5' );
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'سلام' ] ], [] );

		$this->assertSame( [], $response->recommendations );
		$this->assertNotSame( '', trim( $response->reply ) );
	}
}
