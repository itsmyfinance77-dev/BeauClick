<?php
declare( strict_types=1 );

namespace BeauClick\Chat\Tests;

use BeauClick\Chat\Chat\ConversationService;
use BeauClick\Chat\Rest\ChatController;
use WP_UnitTestCase;

final class ChatControllerTest extends WP_UnitTestCase {

	public function test_a_participant_can_access_their_own_conversation(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$conversation = ( new ConversationService() )->start_or_get( $customer, $pro );

		wp_set_current_user( $customer );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/chat/conversations/{$conversation['id']}/messages" );
		$request->set_param( 'id', $conversation['id'] );

		$this->assertTrue( ( new ChatController() )->can_access_conversation( $request ) );
	}

	/**
	 * The bug class this guards against: a conversation has no post_author
	 * to check ownership against (it isn't a CPT) — this asserts the
	 * two-participant-column check actually rejects a stranger, the same
	 * way require_owner_or_capability rejects a non-owner elsewhere.
	 */
	public function test_a_stranger_cannot_access_someone_elses_conversation(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$stranger = self::factory()->user->create();
		$conversation = ( new ConversationService() )->start_or_get( $customer, $pro );

		wp_set_current_user( $stranger );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/chat/conversations/{$conversation['id']}/messages" );
		$request->set_param( 'id', $conversation['id'] );

		$result = ( new ChatController() )->can_access_conversation( $request );
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_an_admin_can_access_any_conversation_for_moderation(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$admin    = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$conversation = ( new ConversationService() )->start_or_get( $customer, $pro );

		wp_set_current_user( $admin );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/chat/conversations/{$conversation['id']}/messages" );
		$request->set_param( 'id', $conversation['id'] );

		$this->assertTrue( ( new ChatController() )->can_access_conversation( $request ) );
	}

	public function test_sending_a_message_through_the_endpoint_persists_it_and_is_visible_to_the_other_participant(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$conversation = ( new ConversationService() )->start_or_get( $customer, $pro );

		wp_set_current_user( $customer );
		$controller = new ChatController();
		$request    = new \WP_REST_Request( 'POST', "/beauclick/v1/chat/conversations/{$conversation['id']}/messages" );
		$request->set_param( 'id', $conversation['id'] );
		$request->set_param( 'body', 'میکاپ عروس چقدر طول می‌کشه؟' );

		$response = $controller->send_message( $request );
		$this->assertSame( 201, $response->get_status() );

		wp_set_current_user( $pro );
		$list_request = new \WP_REST_Request( 'GET', "/beauclick/v1/chat/conversations/{$conversation['id']}/messages" );
		$list_request->set_param( 'id', $conversation['id'] );
		$messages = $controller->list_messages( $list_request )->get_data()['data'];

		$this->assertCount( 1, $messages );
		$this->assertSame( 'میکاپ عروس چقدر طول می‌کشه؟', $messages[0]['body'] );
	}

	public function test_starting_a_conversation_requires_bc_send_message_capability(): void {
		$support = self::factory()->user->create( [ 'role' => 'bc_support' ] ); // support_capabilities() intentionally omits bc_send_message — not a customer-facing sender.
		wp_set_current_user( $support );

		$result = ( new ChatController() )->can_send();
		$this->assertInstanceOf( \WP_Error::class, $result );
	}
}
