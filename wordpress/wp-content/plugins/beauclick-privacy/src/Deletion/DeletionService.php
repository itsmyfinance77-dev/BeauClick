<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Deletion;

use BeauClick\AI\AssistantService;
use BeauClick\Auth\Account\AccountEraser;
use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Waitlist\WaitlistService;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Profile\BeautyProfileService;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Notifications\Preferences\PreferenceService;
use BeauClick\Privacy\DataRequests\DataRequestService;

/**
 * Account deletion, end to end — per the architecture plan's own explicit
 * design decision, this is "admin-reviewed... not instant, irreversible
 * self-execution": a customer's own request only ever reaches `pending`
 * (or `blocked`, if a real conflicting state already exists); only an
 * admin's `approve()` moves it toward actually running, and the real
 * cross-domain work happens on a bounded WP-Cron sweep
 * (`DeletionScheduler`), never synchronously inside that admin's own HTTP
 * request — §31/§32's own "resumable, safe to retry" requirement.
 *
 * Every domain step called from `process()` is itself idempotent (each of
 * beauclick-journey/notifications/ai's own `forget_user()` methods, and
 * beauclick-auth's `AccountEraser::forget()`, checks-before-acting) — so a
 * retry after a partial failure never double-applies and never corrupts
 * state, it just finishes what didn't complete last time.
 */
final class DeletionService {

	public function __construct(
		private readonly DataRequestService $requests = new DataRequestService()
	) {
	}

	/**
	 * §9 — real, unresolved commitments this task's own instructions say
	 * must never be silently overridden. Each one names a real, already-
	 * existing product flow the customer can use to resolve it themselves
	 * (cancel the booking, wait for the order, cancel the membership) —
	 * deletion never force-cancels anything on their behalf.
	 *
	 * @return string[] Persian reasons; an empty array means nothing blocks deletion right now.
	 */
	public function blocking_reasons( int $user_id ): array {
		$reasons = [];

		if ( ( new BookingService() )->has_pending_or_confirmed_booking( $user_id ) ) {
			$reasons[] = 'نوبت در انتظار یا تأییدشده‌ای دارید — لطفاً ابتدا آن را لغو یا تکمیل کنید.';
		}

		foreach ( ( new WaitlistService() )->for_user( $user_id ) as $entry ) {
			if ( 'waiting' === ( $entry['status'] ?? '' ) ) {
				$reasons[] = 'در لیست انتظار یک یا چند نوبت هستید — لطفاً ابتدا آن را لغو کنید.';
				break;
			}
		}

		if ( $this->has_unresolved_order( $user_id ) ) {
			$reasons[] = 'سفارش پرداخت‌نشده یا در حال پردازشی دارید.';
		}

		if ( ( new MembershipService() )->has_active_paid_membership( $user_id ) ) {
			$reasons[] = 'عضویت پولی فعالی دارید — لطفاً ابتدا آن را از بخش «وفاداری و عضویت» لغو کنید.';
		}

		return $reasons;
	}

	private function has_unresolved_order( int $user_id ): bool {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return false;
		}
		$orders = wc_get_orders(
			[
				'customer_id' => $user_id,
				'status'      => [ 'pending', 'on-hold', 'processing' ],
				'limit'       => 1,
				'return'      => 'ids',
			]
		);
		return ! empty( $orders );
	}

	/**
	 * @return array{requestId:int,status:string,reasons?:string[]}
	 */
	public function request_deletion( int $user_id ): array {
		$existing = $this->requests->latest_for_user(
			$user_id,
			DataRequestService::TYPE_DELETION,
			[ DataRequestService::STATUS_PENDING, DataRequestService::STATUS_APPROVED, DataRequestService::STATUS_PROCESSING ]
		);
		if ( $existing ) {
			return [ 'requestId' => (int) $existing['id'], 'status' => $existing['status'] ];
		}

		$reasons = $this->blocking_reasons( $user_id );
		if ( $reasons ) {
			$id = $this->requests->create( $user_id, DataRequestService::TYPE_DELETION, DataRequestService::STATUS_BLOCKED, implode( ' ', $reasons ) );
			return [ 'requestId' => $id, 'status' => DataRequestService::STATUS_BLOCKED, 'reasons' => $reasons ];
		}

		$id = $this->requests->create( $user_id, DataRequestService::TYPE_DELETION, DataRequestService::STATUS_PENDING );
		return [ 'requestId' => $id, 'status' => DataRequestService::STATUS_PENDING ];
	}

	/** A customer may withdraw their own request as long as no admin has acted on it yet. */
	public function cancel( int $request_id, int $user_id ): bool {
		$row = $this->requests->find( $request_id );
		if ( ! $row || (int) $row['user_id'] !== $user_id || DataRequestService::STATUS_PENDING !== $row['status'] ) {
			return false;
		}
		$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_CANCELLED ] );
		return true;
	}

	public function approve( int $request_id, int $admin_id ): bool {
		$row = $this->requests->find( $request_id );
		if ( ! $row || DataRequestService::STATUS_PENDING !== $row['status'] ) {
			return false;
		}
		$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_APPROVED, 'reviewed_at' => current_time( 'mysql' ), 'reviewed_by' => $admin_id ] );
		$this->audit( 'privacy_deletion_approved', (int) $row['user_id'], $admin_id, $row['status'], DataRequestService::STATUS_APPROVED, null );
		return true;
	}

	public function reject( int $request_id, int $admin_id, string $reason ): bool {
		$row = $this->requests->find( $request_id );
		if ( ! $row || DataRequestService::STATUS_PENDING !== $row['status'] ) {
			return false;
		}
		$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_REJECTED, 'reviewed_at' => current_time( 'mysql' ), 'reviewed_by' => $admin_id, 'reason' => $reason ] );
		$this->audit( 'privacy_deletion_rejected', (int) $row['user_id'], $admin_id, $row['status'], DataRequestService::STATUS_REJECTED, $reason );
		return true;
	}

	/**
	 * The real cross-domain erasure — called only from `DeletionScheduler`,
	 * never from an admin's own request thread. Re-validates blocking state
	 * first (it may have changed since approval); only then actually runs.
	 */
	public function process( int $request_id ): void {
		$row = $this->requests->find( $request_id );
		if ( ! $row || DataRequestService::STATUS_APPROVED !== $row['status'] ) {
			return;
		}
		$user_id = (int) $row['user_id'];

		$reasons = $this->blocking_reasons( $user_id );
		if ( $reasons ) {
			$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_BLOCKED, 'reason' => implode( ' ', $reasons ) ] );
			return;
		}

		$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_PROCESSING ] );

		try {
			( new BeautyProfileService() )->forget_user( $user_id );
			( new GoalService() )->forget_user( $user_id );
			( new PreferenceService() )->forget_user( $user_id );
			if ( function_exists( 'beauclick_notifications' ) ) {
				beauclick_notifications()->forget_user( $user_id );
			}
			( new AssistantService() )->forget_user( $user_id );
			( new AccountEraser() )->forget( $user_id ); // Identity last -- every step above still needed a resolvable user_id while it ran.

			$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_COMPLETED, 'completed_at' => current_time( 'mysql' ) ] );
			$this->audit( 'privacy_deletion_completed', $user_id, isset( $row['reviewed_by'] ) ? (int) $row['reviewed_by'] : null, DataRequestService::STATUS_PROCESSING, DataRequestService::STATUS_COMPLETED, null );
		} catch ( \Throwable $e ) {
			// Left retryable ('approved', not stuck at 'processing') --
			// every step above is idempotent, so the next sweep tick safely
			// resumes rather than redoing or corrupting anything.
			$this->requests->update( $request_id, [ 'status' => DataRequestService::STATUS_APPROVED, 'last_error' => $e->getMessage() ] );
		}
	}

	private function audit( string $action_type, int $user_id, ?int $actor_id, string $from_status, string $to_status, ?string $reason ): void {
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record( $action_type, 'user', $user_id, $actor_id, [ 'status' => $from_status ], [ 'status' => $to_status ], $reason );
		}
	}
}
