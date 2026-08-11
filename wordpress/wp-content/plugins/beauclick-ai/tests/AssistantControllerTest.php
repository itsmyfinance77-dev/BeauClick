<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\Rest\AssistantController;
use WP_UnitTestCase;

final class AssistantControllerTest extends WP_UnitTestCase {

	public function test_a_logged_out_visitor_cannot_use_the_assistant(): void {
		wp_set_current_user( 0 );
		$result = ( new AssistantController() )->can_use();
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_a_logged_in_customer_can_use_the_assistant(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );
		$this->assertTrue( ( new AssistantController() )->can_use() );
	}

	public function test_sending_through_the_endpoint_persists_and_lists_the_reply(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$controller = new AssistantController();
		$request    = new \WP_REST_Request( 'POST', '/beauclick/v1/ai/messages' );
		$request->set_param( 'body', 'سلام' );
		$send_response = $controller->send( $request );
		$this->assertSame( 201, $send_response->get_status() );

		$messages = $controller->list_messages()->get_data()['data'];
		$this->assertCount( 2, $messages, 'Both the user message and the assistant reply must be in the conversation history.' );
	}
}
