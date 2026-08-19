<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * V2.4 Step 22. Self-service portfolio management -- the public profile
 * page's own "نمونه‌کار" section has shown a permanent "این بخش در نسخه بعدی
 * محصول تکمیل می‌شود." placeholder since it was first built (no code path
 * ever let a professional add one), even though `bc_portfolio_item` itself
 * was already registered with `supports: ['thumbnail']` and already read
 * back correctly by `MarketplaceController::detail()` -- only the write
 * side was missing.
 *
 * Deliberately uses the real WordPress Media Library (`media_handle_upload()`
 * + `set_post_thumbnail()`), never `beauclick-marketplace\Verification\
 * EvidenceStorage`'s private storage system -- that class's own docblock
 * already documents the exact distinction this controller follows: a
 * portfolio image is a deliberately public, non-sensitive asset (like the
 * profile photo), unlike verification evidence.
 */
final class PortfolioController extends RestController {

	private const MAX_ITEMS_PER_PROVIDER = 24;

	public function register_routes(): void {
		$this->route( '/marketplace/my/portfolio', [ 'methods' => 'GET', 'callback' => [ $this, 'index' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/marketplace/my/portfolio',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'create' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);
		$this->route(
			'/marketplace/my/portfolio/(?P<id>\d+)',
			[
				'methods'             => 'DELETE',
				'callback'            => [ $this, 'delete' ],
				'permission_callback' => [ $this, 'can_edit_item' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	public function can_edit_item( WP_REST_Request $request ): bool|\WP_Error {
		$item = get_post( (int) $request->get_param( 'id' ) );
		if ( ! $item || Registrar::PORTFOLIO_ITEM !== $item->post_type ) {
			return true; // Let the handler 404 -- permission isn't the interesting failure.
		}
		return $this->require_owner_or_capability( (int) $item->post_author, 'bc_manage_platform' );
	}

	private function my_provider_id(): ?int {
		return ProviderLookup::for_user( get_current_user_id() );
	}

	public function index(): \WP_REST_Response {
		$provider_id = $this->my_provider_id();
		if ( ! $provider_id ) {
			return Response::ok( [] );
		}

		$items = get_posts(
			[
				'post_type'      => Registrar::PORTFOLIO_ITEM,
				'post_parent'    => $provider_id,
				'post_status'    => 'any',
				'posts_per_page' => -1,
				'orderby'        => 'date',
				'order'          => 'DESC',
			]
		);

		return Response::ok( array_map( [ $this, 'format' ], $items ) );
	}

	public function create( WP_REST_Request $request ): \WP_REST_Response {
		$provider_id = $this->my_provider_id();
		if ( ! $provider_id ) {
			return Response::error( 'bc_no_profile', __( 'برای افزودن نمونه‌کار ابتدا باید پروفایل متخصص داشته باشید.', 'beauclick-marketplace' ), 404 );
		}

		$existing_count = count(
			get_posts( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_parent' => $provider_id, 'post_status' => 'any', 'posts_per_page' => -1, 'fields' => 'ids' ] )
		);
		if ( $existing_count >= self::MAX_ITEMS_PER_PROVIDER ) {
			return Response::error( 'bc_portfolio_full', __( 'حداکثر تعداد نمونه‌کار قابل افزودن است.', 'beauclick-marketplace' ), 422 );
		}

		$files = $request->get_file_params();
		if ( empty( $files['image'] ) ) {
			return Response::error( 'bc_missing_image', __( 'لطفاً یک تصویر انتخاب کنید.', 'beauclick-marketplace' ), 422 );
		}

		require_once ABSPATH . 'wp-admin/includes/image.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';

		$item_id = wp_insert_post(
			[
				'post_type'   => Registrar::PORTFOLIO_ITEM,
				'post_title'  => sanitize_text_field( (string) $request->get_param( 'title' ) ) ?: __( 'نمونه‌کار', 'beauclick-marketplace' ),
				'post_status' => 'publish',
				'post_author' => get_current_user_id(),
				'post_parent' => $provider_id,
			]
		);
		if ( is_wp_error( $item_id ) ) {
			return Response::error( 'bc_create_failed', __( 'ایجاد نمونه‌کار ناموفق بود.', 'beauclick-marketplace' ), 500 );
		}

		$attachment_id = media_handle_upload( 'image', $item_id );
		if ( is_wp_error( $attachment_id ) ) {
			wp_delete_post( $item_id, true );
			return Response::error( 'bc_upload_failed', __( 'بارگذاری تصویر ناموفق بود. لطفاً یک تصویر معتبر (jpg/png/webp) انتخاب کنید.', 'beauclick-marketplace' ), 422 );
		}

		set_post_thumbnail( $item_id, $attachment_id );

		return Response::ok( $this->format( get_post( $item_id ) ), [], 201 );
	}

	public function delete( WP_REST_Request $request ): \WP_REST_Response {
		wp_trash_post( (int) $request->get_param( 'id' ) );
		return Response::ok( [ 'deleted' => true ] );
	}

	/** @return array<string, mixed> */
	private function format( \WP_Post $item ): array {
		return [
			'id'    => $item->ID,
			'title' => $item->post_title,
			'image' => get_the_post_thumbnail_url( $item->ID, 'large' ) ?: null,
		];
	}
}
