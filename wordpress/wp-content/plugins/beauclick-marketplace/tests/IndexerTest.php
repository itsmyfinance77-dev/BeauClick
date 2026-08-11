<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class IndexerTest extends WP_UnitTestCase {

	public function test_price_from_is_the_minimum_of_the_providers_services(): void {
		global $wpdb;

		$provider_id = self::factory()->post->create(
			[ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_title' => 'تست متخصص' ]
		);

		self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_id, 'meta_input' => [ '_bc_price' => 500000 ] ]
		);
		self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_id, 'meta_input' => [ '_bc_price' => 300000 ] ]
		);

		// Services were inserted after the provider published — force a resync
		// the same way DemoProvidersSeed does, rather than relying on the
		// service's own save_post hook (already covered by
		// test_saving_a_service_resyncs_its_parent below).
		( new \BeauClick\Marketplace\Search\Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );

		$price_from = $wpdb->get_var(
			$wpdb->prepare( "SELECT price_from FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id )
		);

		$this->assertSame( '300000', $price_from, 'price_from must be the MINIMUM service price, not the first one created.' );
	}

	public function test_saving_a_service_resyncs_its_parent_provider(): void {
		global $wpdb;

		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );

		$service_id = self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_id, 'meta_input' => [ '_bc_price' => 100000 ] ]
		);

		$price_from = $wpdb->get_var( $wpdb->prepare( "SELECT price_from FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) );
		$this->assertSame( '100000', $price_from, "Publishing a service must resync its parent's index row automatically via the save_post hook." );
	}

	public function test_unverified_provider_indexes_with_verified_zero(): void {
		global $wpdb;

		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
		update_post_meta( $provider_id, '_bc_verification_status', 'pending' );
		( new \BeauClick\Marketplace\Search\Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );

		$verified = $wpdb->get_var( $wpdb->prepare( "SELECT verified FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) );
		$this->assertSame( '0', $verified );
	}

	public function test_trashing_a_provider_removes_it_from_the_index(): void {
		global $wpdb;

		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
		$this->assertNotNull( $wpdb->get_var( $wpdb->prepare( "SELECT provider_id FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) ) );

		wp_trash_post( $provider_id );

		$this->assertNull(
			$wpdb->get_var( $wpdb->prepare( "SELECT provider_id FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) ),
			'A trashed provider must not still appear in marketplace search results.'
		);
	}
}
