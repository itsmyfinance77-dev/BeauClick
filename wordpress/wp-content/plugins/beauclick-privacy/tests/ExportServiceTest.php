<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Tests;

use BeauClick\Booking\Crm\CrmService;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Privacy\Export\ExportService;
use BeauClick\Privacy\Export\ExportStorage;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_UnitTestCase;

final class ExportServiceTest extends WP_UnitTestCase {

	private function make_booking( int $customer_id, int $provider_id, string $status = 'completed' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 1,
				'slot_start'  => '2026-09-01 10:00:00',
				'slot_end'    => '2026-09-01 11:00:00',
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	public function test_request_generates_a_ready_zip_with_the_expected_sections(): void {
		$user_id = self::factory()->user->create();

		$row = ( new ExportService() )->request( $user_id );

		$this->assertSame( DataRequestService::STATUS_READY, $row['status'] );
		$this->assertNotEmpty( $row['export_token'] );
		$this->assertNotEmpty( $row['export_file'] );

		$path = ( new ExportStorage() )->path_for( $row['export_file'] );
		$this->assertFileExists( $path );

		$zip = new \ZipArchive();
		$this->assertTrue( $zip->open( $path ) );
		$names = [];
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$names[] = $zip->getNameIndex( $i );
		}
		$zip->close();

		foreach ( [ 'account.json', 'bookings.json', 'orders.json', 'reviews.json', 'beauty_journey.json', 'loyalty.json', 'notifications.json', 'referrals.json', 'conversations.json', 'ai_assistant.json', 'ai_professional_assistant.json', 'README.txt' ] as $expected ) {
			$this->assertContains( $expected, $names, "Export ZIP is missing {$expected}" );
		}
	}

	public function test_export_contains_the_customers_own_review_but_never_a_professionals_crm_note_about_them(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id );

		( new ReviewService() )->create( $customer_id, $booking_id, 5, 'یک نظر واقعی برای آزمایش خروجی اطلاعات' );
		( new CrmService() )->add_note( $provider_id, $customer_id, $owner_id, 'یادداشت خصوصی متخصص که هرگز نباید در خروجی مشتری باشد' );

		$row  = ( new ExportService() )->request( $customer_id );
		$path = ( new ExportStorage() )->path_for( $row['export_file'] );

		$zip = new \ZipArchive();
		$zip->open( $path );
		$reviews_json = $zip->getFromName( 'reviews.json' );
		$zip->close();

		$this->assertStringContainsString( 'یک نظر واقعی', $reviews_json );

		// No file in the whole archive may contain the professional's private note text.
		$zip = new \ZipArchive();
		$zip->open( $path );
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$content = $zip->getFromIndex( $i );
			$this->assertStringNotContainsString( 'یادداشت خصوصی متخصص', (string) $content, 'A CRM note about the customer must never appear in the customer\'s own export.' );
		}
		$zip->close();
	}

	public function test_request_reuses_an_already_ready_export_instead_of_regenerating(): void {
		$user_id = self::factory()->user->create();
		$service = new ExportService();

		$first  = $service->request( $user_id );
		$second = $service->request( $user_id );

		$this->assertSame( $first['id'], $second['id'] );
		$this->assertSame( $first['export_token'], $second['export_token'] );
	}
}
