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

	private function make_service( int $provider_id, string $title, int $specialty_id, int $price, string $status = 'publish' ): int {
		$service_id = self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => $status, 'post_parent' => $provider_id, 'post_title' => $title ]
		);
		wp_set_post_terms( $service_id, [ $specialty_id ], Registrar::SPECIALTY );
		update_post_meta( $service_id, '_bc_price', $price );
		return $service_id;
	}

	private function fake_provider_returning( array $recommendations, string $reply = 'باشه' ): \BeauClick\AI\ProviderFactory {
		$provider = new class( $recommendations, $reply ) implements \BeauClick\AI\ProviderInterface {
			public function __construct( private array $recommendations, private string $reply ) {}
			public function chat( array $history, array $context ): \BeauClick\AI\AssistantResponse {
				return new \BeauClick\AI\AssistantResponse( $this->reply, $this->recommendations );
			}
		};
		$factory = $this->createMock( \BeauClick\AI\ProviderFactory::class );
		$factory->method( 'make' )->willReturn( $provider );
		return $factory;
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

	/**
	 * V2.0 Step 1: AssistantService already logged these two into
	 * wp_bc_events before this task started -- closes the gap that nothing
	 * previously asserted the shared event log, only the separate,
	 * AI-specific wp_bc_ai_recommendation_events table.
	 */
	public function test_a_shown_and_clicked_recommendation_both_write_shared_events(): void {
		global $wpdb;
		$term        = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$city_id     = $this->make_city( 'یزد' );
		$provider_id = $this->make_provider( 'سالن تست', (int) $term['term_id'], $city_id );

		$owner   = self::factory()->user->create();
		$service = new AssistantService();
		$result  = $service->send( $owner, 'دنبال میکاپ در یزد هستم' );

		$shown = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = 'ai_recommendation_shown' AND entity_type = 'provider' AND entity_id = %d",
				$provider_id
			),
			ARRAY_A
		);
		$this->assertNotNull( $shown, 'ai_recommendation_shown must be written to the shared event log.' );

		$event_id = $this->first_recommendation_event_id( $result['assistantMessage']['id'] );
		$service->mark_clicked( $event_id, $owner );

		$clicked = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = 'ai_recommendation_clicked' AND entity_type = 'provider' AND entity_id = %d",
				$provider_id
			),
			ARRAY_A
		);
		$this->assertNotNull( $clicked, 'ai_recommendation_clicked must be written to the shared event log.' );
	}

	/**
	 * V2.0 Step 2: validate_recommendations() gained a 'service' branch --
	 * these mirror the existing nonexistent-provider test for every way a
	 * claimed service id can fail to be a real, bookable, published service.
	 */
	public function test_a_recommendation_for_a_nonexistent_service_id_is_dropped(): void {
		$factory = $this->fake_provider_returning( [ [ 'type' => 'service', 'id' => 999999 ] ] );
		$user_id = self::factory()->user->create();

		$result = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$this->assertSame( [], $result['assistantMessage']['recommendations'] );
	}

	public function test_a_recommendation_for_an_unpublished_service_is_dropped(): void {
		$term = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $term['term_id'];
		$provider_id = $this->make_provider( 'سالن تست', $specialty_id, $this->make_city( 'یزد' ) );
		$draft_service = $this->make_service( $provider_id, 'میکاپ عروس', $specialty_id, 2000000, 'draft' );

		$factory = $this->fake_provider_returning( [ [ 'type' => 'service', 'id' => $draft_service ] ] );
		$user_id = self::factory()->user->create();

		$result = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$this->assertSame( [], $result['assistantMessage']['recommendations'], 'A draft/unpublished service must never be recommended.' );
	}

	public function test_a_recommendation_for_a_service_whose_parent_provider_is_unpublished_is_dropped(): void {
		$term = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $term['term_id'];
		$draft_provider = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'draft' ] );
		$orphan_service = $this->make_service( $draft_provider, 'میکاپ عروس', $specialty_id, 2000000 );

		$factory = $this->fake_provider_returning( [ [ 'type' => 'service', 'id' => $orphan_service ] ] );
		$user_id = self::factory()->user->create();

		$result = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$this->assertSame( [], $result['assistantMessage']['recommendations'], 'A service whose parent provider is not published must never be recommended -- it would deep-link into a page that does not exist.' );
	}

	public function test_a_valid_service_recommendation_is_enriched_with_a_provider_prefill_booking_link(): void {
		$term = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $term['term_id'];
		$provider_id = $this->make_provider( 'سالن تست', $specialty_id, $this->make_city( 'یزد' ) );
		$service_id = $this->make_service( $provider_id, 'میکاپ عروس', $specialty_id, 2000000 );

		$factory = $this->fake_provider_returning( [ [ 'type' => 'service', 'id' => $service_id, 'reason' => 'دقیقاً همون چیزی که خواستی' ] ] );
		$user_id = self::factory()->user->create();

		$result = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );
		$rec    = $result['assistantMessage']['recommendations'][0];

		$this->assertSame( 'service', $rec['type'] );
		$this->assertSame( $service_id, $rec['id'] );
		$this->assertSame( $provider_id, $rec['providerId'] );
		$this->assertStringContainsString( 'book_provider=' . $provider_id, $rec['url'] );
		$this->assertStringContainsString( 'book_service=' . $service_id, $rec['url'] );
		$this->assertSame( 'دقیقاً همون چیزی که خواستی', $rec['reason'], 'A provider-supplied reason must be threaded through to the enriched card, never dropped or replaced.' );
	}

	/**
	 * Mirrors test_a_recommendation_for_a_nonexistent_provider_id_is_dropped
	 * for the 'product' branch of validate_recommendations() -- not
	 * previously covered on its own.
	 */
	public function test_a_recommendation_for_a_nonexistent_product_id_is_dropped(): void {
		$factory = $this->fake_provider_returning( [ [ 'type' => 'product', 'id' => 999999 ] ] );
		$user_id = self::factory()->user->create();

		$result = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$this->assertSame( [], $result['assistantMessage']['recommendations'] );
	}

	public function test_a_recommendation_for_a_hidden_catalog_visibility_product_is_dropped(): void {
		$product = new \WC_Product_Simple();
		$product->set_name( 'محصول مخفی' );
		$product->set_regular_price( '100000' );
		$product->set_price( '100000' );
		$product->set_catalog_visibility( 'hidden' );
		$product->set_status( 'publish' );
		$product->save();

		$factory = $this->fake_provider_returning( [ [ 'type' => 'product', 'id' => $product->get_id() ] ] );
		$user_id = self::factory()->user->create();

		$result = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$this->assertSame( [], $result['assistantMessage']['recommendations'], 'A hidden booking-only product must never be recommended as an ordinary shop product.' );
	}

	/**
	 * Runs through the REAL default provider (RuleBasedProvider, via the
	 * default ProviderFactory) -- confirms the medical-safety short-circuit
	 * added in RuleBasedProvider::chat() is actually wired end-to-end
	 * through AssistantService::send(), not just unit-tested in isolation.
	 */
	public function test_a_medical_concern_message_never_produces_a_diagnosis_or_recommendations(): void {
		$user_id = self::factory()->user->create();
		$result  = ( new AssistantService() )->send( $user_id, 'پوستم عفونت کرده، تشخیص بده چیه' );

		$this->assertIsArray( $result );
		$this->assertSame( [], $result['assistantMessage']['recommendations'] );
		$this->assertStringContainsString( 'پزشک', $result['assistantMessage']['body'] );
	}

	public function test_marking_a_service_recommendation_clicked_writes_a_shared_event_with_service_entity_type(): void {
		global $wpdb;
		$term = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $term['term_id'];
		$provider_id = $this->make_provider( 'سالن تست', $specialty_id, $this->make_city( 'یزد' ) );
		$service_id = $this->make_service( $provider_id, 'میکاپ عروس', $specialty_id, 2000000 );

		$factory = $this->fake_provider_returning( [ [ 'type' => 'service', 'id' => $service_id ] ] );
		$owner   = self::factory()->user->create();
		$service = new AssistantService( $factory );
		$result  = $service->send( $owner, 'سلام' );

		$event_id = $this->first_recommendation_event_id( $result['assistantMessage']['id'] );
		$this->assertTrue( $service->mark_clicked( $event_id, $owner ) );

		$clicked = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = 'ai_recommendation_clicked' AND entity_type = 'service' AND entity_id = %d",
				$service_id
			),
			ARRAY_A
		);
		$this->assertNotNull( $clicked );
	}

	/**
	 * V2.0 Step 4: Beauty Journey provides context, AI remains solely
	 * responsible for recommendation reasoning -- verified here by
	 * inspecting the actual $context a provider receives, not by re-testing
	 * RuleBasedProvider's own matching logic (already covered elsewhere).
	 */
	public function test_a_stored_beauty_profile_preference_reaches_the_provider_as_default_context(): void {
		if ( ! class_exists( \BeauClick\Journey\Profile\BeautyProfileService::class ) ) {
			$this->markTestSkipped( 'beauclick-journey not active.' );
		}

		$user_id = self::factory()->user->create();
		( new \BeauClick\Journey\Profile\BeautyProfileService() )->update( $user_id, [ 'preferredCityId' => 37, 'budgetMax' => 2000000 ] );

		$provider = new class implements \BeauClick\AI\ProviderInterface {
			public array $captured = [];
			public function chat( array $history, array $context ): \BeauClick\AI\AssistantResponse {
				$this->captured = $context;
				return new \BeauClick\AI\AssistantResponse( 'باشه' );
			}
		};
		$factory = $this->createMock( \BeauClick\AI\ProviderFactory::class );
		$factory->method( 'make' )->willReturn( $provider );

		( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$this->assertSame( 37, $provider->captured['cityId'] ?? null );
		$this->assertSame( 2000000, $provider->captured['budget'] ?? null );
	}

	/**
	 * A conversation's OWN explicit signal (already extracted into
	 * ai_context from a previous turn) must win over the journey's general
	 * default -- the merge order is journey-defaults-first, conversation-
	 * context-second.
	 */
	public function test_an_explicit_conversation_signal_overrides_the_journey_default(): void {
		if ( ! class_exists( \BeauClick\Journey\Profile\BeautyProfileService::class ) ) {
			$this->markTestSkipped( 'beauclick-journey not active.' );
		}

		$user_id = self::factory()->user->create();
		( new \BeauClick\Journey\Profile\BeautyProfileService() )->update( $user_id, [ 'preferredCityId' => 37 ] );

		// Seed the conversation's own ai_context with a conflicting city --
		// simulating a prior turn that already stated a different city.
		global $wpdb;
		$service      = new AssistantService();
		$conversation = $service->get_or_create_conversation( $user_id );
		$wpdb->update(
			$wpdb->prefix . 'bc_ai_conversations',
			[ 'ai_context' => wp_json_encode( [ 'cityId' => 10 ] ) ],
			[ 'id' => $conversation['id'] ]
		);

		$captured_context = [];
		$provider = new class( $captured_context ) implements \BeauClick\AI\ProviderInterface {
			public array $captured = [];
			public function chat( array $history, array $context ): \BeauClick\AI\AssistantResponse {
				$this->captured = $context;
				return new \BeauClick\AI\AssistantResponse( 'باشه' );
			}
		};
		$factory = $this->createMock( \BeauClick\AI\ProviderFactory::class );
		$factory->method( 'make' )->willReturn( $provider );

		( new AssistantService( $factory ) )->send( $user_id, 'سلام دوباره' );

		$this->assertSame( 10, $provider->captured['cityId'], "The conversation's own already-stated city must win over the journey profile's general default." );
	}

	/**
	 * Two distinct recommendations in the same reply must each get their
	 * own event id -- clicking one must never be attributable to the other.
	 */
	public function test_multiple_recommendations_in_one_reply_get_distinct_event_ids(): void {
		$term = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $term['term_id'];
		$provider_id = $this->make_provider( 'سالن تست', $specialty_id, $this->make_city( 'یزد' ) );
		$service_id = $this->make_service( $provider_id, 'میکاپ عروس', $specialty_id, 2000000 );

		$factory = $this->fake_provider_returning(
			[ [ 'type' => 'provider', 'id' => $provider_id ], [ 'type' => 'service', 'id' => $service_id ] ]
		);
		$user_id = self::factory()->user->create();
		$result  = ( new AssistantService( $factory ) )->send( $user_id, 'سلام' );

		$recs = $result['assistantMessage']['recommendations'];
		$this->assertCount( 2, $recs );
		$this->assertNotSame( $recs[0]['eventId'], $recs[1]['eventId'] );
	}
}
