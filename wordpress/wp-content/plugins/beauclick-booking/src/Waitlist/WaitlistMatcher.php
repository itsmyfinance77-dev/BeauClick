<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Waitlist;

use BeauClick\Core\Support\JalaliDate;

/**
 * V2.1 Step 10 — reacts to the authoritative `beauclick/booking/slot_opened`
 * event (fired from BookingService::cancel_booking()/expire_stale_holds(),
 * the only two real "a slot became available" moments) and *offers* the
 * slot to matching waitlist entries by notification only.
 *
 * Deliberately never reserves or locks the slot for anyone — §16's hard
 * requirement. The existing atomic `create_booking()` claim remains the
 * only thing that actually decides who gets it; two customers notified
 * about the same opening racing for it is resolved exactly the same way
 * two strangers browsing the site at the same moment already are today.
 *
 * Policy (§15 — "a reasonable, testable policy, not a complicated
 * auction"): FIFO by request age, capped to a small batch per real
 * opening (never "notify everyone forever"), with a per-entry cooldown so
 * a burst of near-simultaneous openings can't spam the same customer
 * repeatedly.
 */
final class WaitlistMatcher {

	private const BATCH_SIZE       = 5;
	private const COOLDOWN_MINUTES = 30;

	public function register(): void {
		add_action( 'beauclick/booking/slot_opened', [ $this, 'on_slot_opened' ], 10, 4 );
	}

	public function on_slot_opened( int $slot_id, int $provider_id, ?int $service_id, string $slot_date ): void {
		if ( ! function_exists( 'beauclick_notifications' ) ) {
			return;
		}

		$matches = ( new WaitlistService() )->matching( $provider_id, $service_id, $slot_date );
		if ( ! $matches ) {
			return;
		}

		$provider      = get_post( $provider_id );
		$provider_name = $provider ? $provider->post_title : __( 'متخصص', 'beauclick-booking' );
		$when          = JalaliDate::format( $slot_date, false );
		$booking_url   = $provider ? get_permalink( $provider_id ) : home_url( '/marketplace/' );

		$notified_count = 0;
		foreach ( $matches as $entry ) {
			if ( $notified_count >= self::BATCH_SIZE ) {
				break;
			}
			if ( $entry['notifiedAt'] && strtotime( (string) $entry['notifiedAt'] ) > strtotime( '-' . self::COOLDOWN_MINUTES . ' minutes' ) ) {
				continue; // Already notified about something very recently -- avoid spamming a burst of near-simultaneous openings.
			}

			$customer = get_userdata( $entry['customerId'] );

			beauclick_notifications()->notify(
				\BeauClick\Notifications\Preferences\PreferenceService::CATEGORY_WAITLIST,
				\BeauClick\Notifications\Templates\TemplateRegistry::WAITLIST_SLOT_AVAILABLE,
				$entry['customerId'],
				[
					'customerName' => $customer ? $customer->display_name : '',
					'providerName' => $provider_name,
					'when'         => $when,
					'bookingUrl'   => $booking_url ?: home_url( '/marketplace/' ),
				],
				// Scoping the idempotency entity to THIS specific slot (not
				// just the waitlist entry) is deliberate: a slot can open,
				// get claimed, and later open again -- each is a genuinely
				// new opportunity worth a fresh notification, so the
				// dedupe key must include which opening this is, not just
				// who's being notified.
				'wl_slot_' . $slot_id,
				$entry['id'],
				[ 'sms', 'email' ]
			);

			( new WaitlistService() )->mark_notified( $entry['id'] );
			++$notified_count;
		}
	}
}
