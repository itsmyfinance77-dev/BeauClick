<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\AssistantService;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\Indexer;
use WP_UnitTestCase;

final class AssistantServiceTest extends WP_UnitTestCase {

	private function make_city( string $name_fa ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_cities',
			[ 'province_id' => 1, 'name_fa' => $name_fa, 'slug' => sanitize_title( $name_fa ) . '-' . wp_rand(), 'is_launched' => 1 ],
			[ '%d', '%s', '%s', '%d' ]
		);
		return $wpdb->insert_id;
	}

	private function make_provider( string $name, int $specialty_id, int $city_id ): int {
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_title' => $name ] );
		wp_set_post_terms( $provider_id, [ $specialty_id ], Registrar::SPECIALTY );
		update_post_meta( $provider_id, '_bc_city_id', $city_id );
		( new Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );
		return $provider_id;
	}

	public function test_sending_a_message_with_a_matching_specialty_recommends_a_real_provider(): void {
		$term     = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$city_id  = $this->make_city( 'یزد' );
		$provider_id = $this->make_provider( 'سالن تست', (int) $term['term_id'], $city_id );

		$user_id = self::factory()->user->create();
		$result  = ( new AssistantService() )->send( $user_id, 'دنبال میکاپ در یزد هستم' );

		$this->assertIsArray( $result );
		$recommendations = $result['assistantMessage']['recommendations'];
		$this->assertNotEmpty( $recommendations, 'A matching real provider must be recommended, not an empty list.' );
		$this->assertSame( 'provider', $recommendations[0]['type'] );
		$this->assertSame( $provider_id, $recommendations[0]['id'] );
	}

	public function test_a_message_with_no_recognizable_specialty_asks_a_clarifying_question_without_recommending_anything(): void {
		$user_id = self::factory()->user->create();
		$result  = ( new AssistantService() )->send( $user_id, 'سلام' );

		$this->assertIsArray( $result );
		$this->assertSame( [], $result['assistantMessage']['recommendations'] );
	}

	public function test_a_second_message_reuses_the_same_conversation(): void {
		$user_id = self::factory()->user->create();
		$service = new AssistantService();

		$first  = $service->send( $user_id, 'سلام' );
		$second = $service->send( $user_id, 'دوباره سلام' );

		$this->assertSame( $first['userMessage']['conversationId'], $second['userMessage']['conversationId'] );
	}

	public function test_blank_message_is_rejected_with_a_string_error_not_persisted(): void {
		$user_id = self::factory()->user->create();
		$result  = ( new AssistantService() )->send( $user_id, '   ' );

		$this->assertIsString( $result );

		$conversation = ( new AssistantService() )->get_or_create_conversation( $user_id );
		$this->assertCount( 0, ( new AssistantService() )->messages( $conversation['id'] ) );
	}

	public function test_rate_limit_blocks_a_burst_beyond_the_cap(): void {
		$user_id = self::factory()->user->create();
		$service = new AssistantService();

		for ( $i = 0; $i < 15; $i++ ) {
			$this->assertIsArray( $service->send( $user_id, "پیام {$i}" ), "Message {$i} should still be within the rate limit." );
		}

		$this->assertFalse( $service->send( $user_id, 'یک پیام دیگر' ), 'A 16th message within the window must be rate-limited.' );
	}

	/**
	 * The core defense the architecture doc calls out for §16: a provider
	 * claiming a recommendation ID that doesn't exist in the real catalog
	 * must never reach persistence/render, regardless of which
	 * ProviderInterface implementation produced it.
	 */
	public function test_a_recommendation_for_a_nonexistent_provider_id_is_dropped(): void {
		$fake_provider = new class implements \BeauClick\AI\ProviderInterface {
			public function chat( array $history, array $context ): \BeauClick\AI\AssistantResponse {
				return new \BeauClick\AI\AssistantResponse( 'پیشنهاد من', [ [ 'type' => 'provider', 'id' => 999999 ] ] );
			}
		};

		$factory = $this->createMock( \BeauClick\AI\ProviderFactory::class );
		$factory->method( 'make' )->willReturn( $fake_provider );

		$service = new AssistantService( $factory );
		$user_id = self::factory()->user->create();
		$result  = $service->send( $user_id, 'سلام' );

		$this->assertSame( [], $result['assistantMessage']['recommendations'], 'A recommendation for a provider_id with no matching row must never be persisted or shown.' );
	}

	public function test_marking_a_recommendation_clicked_requires_owning_the_conversation(): void {
		$term        = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$city_id     = $this->make_city( 'یزد' );
		$this->make_provider( 'سالن تست', (int) $term['term_id'], $city_id );

		$owner   = self::factory()->user->create();
		$stranger = self::factory()->user->create();
		$service = new AssistantService();
		$result  = $service->send( $owner, 'دنبال میکاپ در یزد هستم' );
		$event_id = $this->first_recommendation_event_id( $result['assistantMessage']['id'] );

		$this->assertFalse( $service->mark_clicked( $event_id, $stranger ), "A user must not be able to mark another user's AI recommendation as clicked." );
		$this->assertTrue( $service->mark_clicked( $event_id, $owner ) );
	}

	private function first_recommendation_event_id( int $message_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_ai_recommendation_events WHERE message_id = %d LIMIT 1", $message_id ) );
	}
}
