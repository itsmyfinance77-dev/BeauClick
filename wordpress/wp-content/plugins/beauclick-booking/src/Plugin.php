<?php
declare( strict_types=1 );

namespace BeauClick\Booking;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Cron\HoldExpiryScheduler;
use BeauClick\Booking\Cron\RankingScheduler;
use BeauClick\Booking\Database\Migrations\AddHoldExpiryColumns;
use BeauClick\Booking\Database\Migrations\CreateBookingReschedulesTable;
use BeauClick\Booking\Database\Migrations\CreateBookingTables;
use BeauClick\Booking\Database\Migrations\CreateCrmNotesTable;
use BeauClick\Booking\Database\Migrations\CreateWaitlistTable;
use BeauClick\Booking\Database\Seeds\DemoAvailabilitySeed;
use BeauClick\Booking\Ranking\RankingEngine;
use BeauClick\Booking\Rebooking\RebookingScheduler;
use BeauClick\Booking\Reminders\ReminderScheduler;
use BeauClick\Booking\Retention\RetentionScheduler;
use BeauClick\Booking\Rest\AvailabilityController;
use BeauClick\Booking\Rest\BookingController;
use BeauClick\Booking\Rest\CrmController;
use BeauClick\Booking\Rest\DashboardController;
use BeauClick\Booking\Rest\WaitlistController;
use BeauClick\Booking\Waitlist\WaitlistExpiryScheduler;
use BeauClick\Booking\Waitlist\WaitlistMatcher;

final class Plugin {

	private const GROUP = 'beauclick-booking';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function migrations(): array {
		return [ new CreateBookingTables(), new AddHoldExpiryColumns(), new CreateCrmNotesTable(), new CreateWaitlistTable(), new CreateBookingReschedulesTable() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
		add_action( 'beauclick/seed', [ $this, 'maybe_seed' ] );

		$scheduler = new HoldExpiryScheduler();
		$scheduler->register();
		add_action( 'admin_init', [ $scheduler, 'ensure_scheduled' ] ); // Cheap idempotent check; re-arms the event if it was ever cleared without needing a manual reactivation.

		$ranking_scheduler = new RankingScheduler();
		$ranking_scheduler->register();
		add_action( 'admin_init', [ $ranking_scheduler, 'ensure_scheduled' ] );

		// V2.1 Step 10 -- Waitlist reacts to the authoritative
		// beauclick/booking/slot_opened event fired from cancel_booking()/
		// expire_stale_holds() (see BookingService); never a second lock,
		// the existing atomic create_booking() claim stays authoritative.
		( new WaitlistMatcher() )->register();

		foreach ( [ new ReminderScheduler(), new RebookingScheduler(), new RetentionScheduler(), new WaitlistExpiryScheduler() ] as $step10_scheduler ) {
			$step10_scheduler->register();
			add_action( 'admin_init', [ $step10_scheduler, 'ensure_scheduled' ] );
		}

		// V2.0 Step 3: real-time single-provider ranking recompute, one hook
		// per "something that could move this provider's score just
		// happened" — same hook-based, source-fires/consumer-subscribes
		// convention as every other cross-plugin seam in this codebase.
		// beauclick/marketplace/provider_indexed fires (post_id, post_type)
		// directly matching recompute_one()'s signature; the other two only
		// carry a booking/review id, so a tiny lookup resolves provider_id
		// first — see recompute_for_booking() below.
		add_action( 'beauclick/marketplace/provider_indexed', [ $this, 'recompute_ranking_for_post' ], 10, 2 );
		add_action( 'beauclick/booking/completed', [ $this, 'recompute_ranking_for_booking' ] );
		add_action( 'beauclick/reviews/submitted', [ $this, 'recompute_ranking_for_review' ], 10, 3 );
	}

	public function recompute_ranking_for_post( int $postId, string $postType ): void {
		( new RankingEngine() )->recompute_one( $postId, $postType );
	}

	public function recompute_ranking_for_booking( int $bookingId ): void {
		$this->recompute_for_booking( $bookingId );
	}

	public function recompute_ranking_for_review( int $reviewId, int $authorId, int $bookingId ): void {
		$this->recompute_for_booking( $bookingId );
	}

	/**
	 * Both booking-completion and review-submission hooks only carry a
	 * booking id, not a provider id/type — booking already owns
	 * wp_bc_bookings, so resolving provider_id here is a same-plugin lookup,
	 * not a new cross-plugin read.
	 */
	private function recompute_for_booking( int $bookingId ): void {
		$booking = ( new BookingService() )->find( $bookingId );
		if ( ! $booking ) {
			return;
		}
		$provider_id   = (int) $booking['provider_id'];
		$provider_type = get_post_type( $provider_id );
		if ( $provider_type ) {
			( new RankingEngine() )->recompute_one( $provider_id, $provider_type );
		}
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new BookingController() )->register_routes();
		( new DashboardController() )->register_routes();
		( new CrmController() )->register_routes();
		( new WaitlistController() )->register_routes();
		( new AvailabilityController() )->register_routes();
	}

	public function maybe_seed( ?string $only ): void {
		if ( $only !== null && $only !== 'booking' ) {
			return;
		}
		DemoAvailabilitySeed::run();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );

		( new HoldExpiryScheduler() )->ensure_scheduled();
		( new RankingScheduler() )->ensure_scheduled();
		( new ReminderScheduler() )->ensure_scheduled();
		( new RebookingScheduler() )->ensure_scheduled();
		( new RetentionScheduler() )->ensure_scheduled();
		( new WaitlistExpiryScheduler() )->ensure_scheduled();
	}

	public static function deactivate(): void {
		( new HoldExpiryScheduler() )->unschedule();
		( new RankingScheduler() )->unschedule();
		( new ReminderScheduler() )->unschedule();
		( new RebookingScheduler() )->unschedule();
		( new RetentionScheduler() )->unschedule();
		( new WaitlistExpiryScheduler() )->unschedule();
	}
}
