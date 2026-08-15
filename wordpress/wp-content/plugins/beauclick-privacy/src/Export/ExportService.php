<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Export;

use BeauClick\AI\AssistantService;
use BeauClick\AI\Professional\ProfessionalAssistantService;
use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Waitlist\WaitlistService;
use BeauClick\Chat\Chat\ConversationService;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Profile\BeautyProfileService;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Notifications\Preferences\PreferenceService;
use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Referral\ReferralService;
use BeauClick\Reviews\Reviews\ReviewService;

/**
 * Orchestrates a customer's own data export — a deliberate, structured
 * schema (§11's own explicit "do not blindly dump raw database tables"
 * instruction), assembled by calling each domain plugin's own
 * `export_for_*()`/`for_user()`/`summary_for_user()` method (added
 * alongside this step, one small method per plugin) rather than this
 * plugin reaching into any other plugin's tables directly.
 *
 * Synchronous generation — per §14's own "a safe synchronous
 * implementation may be acceptable for smaller accounts" guidance and this
 * product's real current data volume (a handful of bookings/orders/reviews
 * per customer, not thousands) — no queue/job infrastructure introduced
 * for this. A ZIP of small, human-readable JSON files plus a Persian
 * README, matching §12's own suggested shape.
 */
final class ExportService {

	private const EXPIRY_HOURS = 24;

	public function __construct(
		private readonly DataRequestService $requests = new DataRequestService(),
		private readonly ExportStorage $storage = new ExportStorage()
	) {
	}

	/**
	 * Reuses an already-generated, still-valid export rather than
	 * regenerating on every click — the underlying data changes slowly
	 * (nobody's booking history meaningfully changes minute to minute), and
	 * regenerating on every request would mean a customer could trivially
	 * churn through many ZIP files sitting in protected storage for no
	 * reason.
	 *
	 * @return array<string, mixed> The export request row.
	 */
	public function request( int $user_id ): array {
		$existing = $this->requests->latest_for_user( $user_id, DataRequestService::TYPE_EXPORT, [ DataRequestService::STATUS_READY ] );
		if ( $existing && ! empty( $existing['expires_at'] ) && strtotime( (string) $existing['expires_at'] ) > time() ) {
			return $existing;
		}

		$request_id = $this->requests->create( $user_id, DataRequestService::TYPE_EXPORT, 'pending' );

		try {
			$this->generate( (int) $request_id, $user_id );
		} catch ( \Throwable $e ) {
			$this->requests->update( (int) $request_id, [ 'status' => DataRequestService::STATUS_FAILED, 'last_error' => $e->getMessage() ] );
		}

		return $this->requests->find( (int) $request_id );
	}

	private function generate( int $request_id, int $user_id ): void {
		$sections = $this->collect( $user_id );

		$tmp_dir = trailingslashit( get_temp_dir() ) . 'bc-export-' . $request_id . '-' . wp_generate_password( 12, false );
		wp_mkdir_p( $tmp_dir );

		try {
			foreach ( $sections as $name => $payload ) {
				file_put_contents( "{$tmp_dir}/{$name}.json", wp_json_encode( $payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE ) );
			}
			file_put_contents( "{$tmp_dir}/README.txt", $this->readme_text() );

			$filename = $this->storage->reserve_filename();
			$zip_path = $this->storage->path_for( $filename );

			$zip = new \ZipArchive();
			if ( true !== $zip->open( $zip_path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE ) ) {
				throw new \RuntimeException( 'ساخت فایل خروجی ناموفق بود.' );
			}
			foreach ( glob( "{$tmp_dir}/*" ) ?: [] as $file ) {
				$zip->addFile( $file, basename( $file ) );
			}
			$zip->close();

			$token = bin2hex( random_bytes( 32 ) );
			$this->requests->update(
				$request_id,
				[
					'status'       => DataRequestService::STATUS_READY,
					'export_token' => $token,
					'export_file'  => $filename,
					'expires_at'   => gmdate( 'Y-m-d H:i:s', time() + self::EXPIRY_HOURS * HOUR_IN_SECONDS ),
				]
			);
		} finally {
			// The ZIP (or nothing, on failure) is the only copy that
			// persists — the plain-text working directory is always
			// cleaned up, success or failure.
			foreach ( glob( "{$tmp_dir}/*" ) ?: [] as $file ) {
				wp_delete_file( $file );
			}
			@rmdir( $tmp_dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a non-empty/already-gone temp dir here is not a real error worth surfacing.
		}
	}

	/** @return array<string, mixed> */
	private function collect( int $user_id ): array {
		$user = get_userdata( $user_id );

		return [
			'account'            => [
				'displayName'  => $user ? $user->display_name : null,
				'email'        => $user ? $user->user_email : null,
				'registeredAt' => $user ? $user->user_registered : null,
			],
			'bookings'           => ( new BookingService() )->export_for_customer( $user_id ),
			'waitlist'           => ( new WaitlistService() )->for_user( $user_id ),
			'orders'             => $this->export_orders( $user_id ),
			'reviews'            => ( new ReviewService() )->for_author( $user_id ),
			'beauty_journey'     => [
				'profile' => ( new BeautyProfileService() )->get( $user_id ),
				'goals'   => ( new GoalService() )->for_user( $user_id ),
			],
			'loyalty'            => [
				'pointsBalance' => beauclick_loyalty()->ledger()->balance( $user_id ),
				'pointsHistory' => beauclick_loyalty()->ledger()->history( $user_id, 1000 ),
				'membership'    => ( new MembershipService() )->for_user( $user_id ),
			],
			'notifications'      => [
				'preferences' => ( new PreferenceService() )->for_user( $user_id ),
				'history'     => function_exists( 'beauclick_notifications' ) ? beauclick_notifications()->for_user( $user_id, 1000 ) : [],
			],
			'referrals'          => ( new ReferralService() )->summary_for_user( $user_id ),
			'conversations'      => ( new ConversationService() )->export_for_user( $user_id ),
			'ai_assistant'       => ( new AssistantService() )->export_for_user( $user_id ),
			'ai_professional_assistant' => ( new ProfessionalAssistantService() )->export_for_user( $user_id ),
		];
	}

	/** @return array<int, array<string, mixed>> */
	private function export_orders( int $user_id ): array {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return [];
		}
		$orders = wc_get_orders( [ 'customer_id' => $user_id, 'limit' => -1, 'type' => 'shop_order' ] );
		return array_map(
			static function ( \WC_Order $order ): array {
				return [
					'orderId'    => $order->get_id(),
					'status'     => $order->get_status(),
					'total'      => (float) $order->get_total(),
					'currency'   => $order->get_currency(),
					'createdAt'  => $order->get_date_created() ? $order->get_date_created()->date( 'Y-m-d H:i:s' ) : null,
					'items'      => array_map(
						static fn ( $item ) => [ 'name' => $item->get_name(), 'quantity' => $item->get_quantity(), 'total' => (float) $item->get_total() ],
						array_values( $order->get_items() )
					),
				];
			},
			$orders ?: []
		);
	}

	private function readme_text(): string {
		return "این پروندهٔ فشرده شامل اطلاعاتی است که BeauClick دربارهٔ حساب کاربری شما نگه‌داری می‌کند.\n\n" .
			"account.json — اطلاعات پایه حساب\n" .
			"bookings.json — تاریخچه نوبت‌های شما\n" .
			"waitlist.json — درخواست‌های لیست انتظار شما\n" .
			"orders.json — سفارش‌های فروشگاهی شما\n" .
			"reviews.json — نظراتی که ثبت کرده‌اید\n" .
			"beauty_journey.json — پروفایل و اهداف «مسیر زیبایی من»\n" .
			"loyalty.json — امتیاز و عضویت وفاداری\n" .
			"notifications.json — تنظیمات و تاریخچه اعلان‌ها\n" .
			"referrals.json — اطلاعات معرفی به دوستان\n" .
			"conversations.json — پیام‌های ارسالی شما در گفتگوها\n" .
			"ai_assistant.json — گفتگوی شما با دستیار هوشمند\n\n" .
			"این فایل حاوی یادداشت‌های داخلی متخصصان دربارهٔ شما نیست — آن یادداشت‌ها فقط برای همان متخصص قابل مشاهده است.\n";
	}
}
