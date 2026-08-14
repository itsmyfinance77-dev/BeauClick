<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Notifications;

use BeauClick\Core\Support\JalaliDate;

/**
 * Real transactional email via wp_mail() — no new infra, matching the
 * .env scaffold's BC_MAIL_FROM_ADDRESS/BC_MAIL_FROM_NAME (present since
 * Phase 0, unused until now). Whether mail actually delivers depends on
 * the environment having a working transport (SMTP plugin, configured
 * sendmail, …) — local dev typically doesn't, same caveat as the COD
 * payment gateway being a local-only placeholder. Tests intercept via the
 * `pre_wp_mail` filter rather than requiring a real transport.
 */
final class BookingMailer {

	public function send_confirmed( array $booking ): void {
		$customer = get_userdata( (int) $booking['customer_id'] );
		if ( ! $customer || ! is_email( $customer->user_email ) ) {
			return;
		}

		$provider_name = get_the_title( (int) $booking['provider_id'] ) ?: __( 'متخصص', 'beauclick-booking' );
		$when          = $this->format_when( $booking['slot_start'] );

		wp_mail(
			$customer->user_email,
			__( 'نوبت شما تأیید شد — BeauClick', 'beauclick-booking' ),
			sprintf(
				/* translators: 1: provider name, 2: date/time */
				__( "سلام %1\$s،\n\nنوبت شما با %2\$s برای %3\$s تأیید شد.\n\nBeauClick", 'beauclick-booking' ),
				$customer->display_name,
				$provider_name,
				$when
			)
		);
	}

	/**
	 * Notifies whichever party did NOT perform the cancellation — the
	 * actor already knows (they just clicked the button), the other side
	 * doesn't. $actor_user_id is get_current_user_id() at the point of
	 * cancellation (0 for the system/cron sweep, which notifies both).
	 */
	public function send_cancelled( array $booking, int $actor_user_id ): void {
		$provider_owner_id = (int) get_post_field( 'post_author', (int) $booking['provider_id'] );
		$when               = $this->format_when( $booking['slot_start'] );

		if ( $actor_user_id !== (int) $booking['customer_id'] ) {
			$customer = get_userdata( (int) $booking['customer_id'] );
			if ( $customer && is_email( $customer->user_email ) ) {
				wp_mail(
					$customer->user_email,
					__( 'نوبت شما لغو شد — BeauClick', 'beauclick-booking' ),
					sprintf(
						/* translators: %s: date/time */
						__( "سلام %1\$s،\n\nنوبت شما برای %2\$s لغو شد.\n\nBeauClick", 'beauclick-booking' ),
						$customer->display_name,
						$when
					)
				);
			}
		}

		if ( $actor_user_id !== $provider_owner_id ) {
			$provider = get_userdata( $provider_owner_id );
			if ( $provider && is_email( $provider->user_email ) ) {
				wp_mail(
					$provider->user_email,
					__( 'یک نوبت لغو شد — BeauClick', 'beauclick-booking' ),
					sprintf(
						/* translators: %s: date/time */
						__( "سلام %1\$s،\n\nنوبت شما برای %2\$s توسط مشتری لغو شد.\n\nBeauClick", 'beauclick-booking' ),
						$provider->display_name,
						$when
					)
				);
			}
		}
	}

	/**
	 * V2.2 Step 15 — same "whichever party did NOT act already knows"
	 * convention as send_cancelled(): the actor just clicked reschedule,
	 * the other side didn't. $actor_user_id === 0 (an admin/system actor
	 * with no matching party) notifies both, same as send_cancelled().
	 */
	public function send_rescheduled( array $old_booking, array $new_booking, int $actor_user_id ): void {
		$provider_name = get_the_title( (int) $new_booking['provider_id'] ) ?: __( 'متخصص', 'beauclick-booking' );
		$old_when      = $this->format_when( $old_booking['slot_start'] );
		$new_when      = $this->format_when( $new_booking['slot_start'] );

		if ( $actor_user_id !== (int) $new_booking['customer_id'] ) {
			$customer = get_userdata( (int) $new_booking['customer_id'] );
			if ( $customer && is_email( $customer->user_email ) ) {
				wp_mail(
					$customer->user_email,
					__( 'نوبت شما جابه‌جا شد — BeauClick', 'beauclick-booking' ),
					sprintf(
						/* translators: 1: customer name, 2: provider name, 3: old date/time, 4: new date/time */
						__( "سلام %1\$s،\n\nنوبت شما با %2\$s از %3\$s به %4\$s تغییر یافت.\n\nBeauClick", 'beauclick-booking' ),
						$customer->display_name,
						$provider_name,
						$old_when,
						$new_when
					)
				);
			}
		}

		$provider_owner_id = (int) get_post_field( 'post_author', (int) $new_booking['provider_id'] );
		if ( $actor_user_id !== $provider_owner_id ) {
			$provider = get_userdata( $provider_owner_id );
			if ( $provider && is_email( $provider->user_email ) ) {
				wp_mail(
					$provider->user_email,
					__( 'یک نوبت جابه‌جا شد — BeauClick', 'beauclick-booking' ),
					sprintf(
						/* translators: 1: provider name, 2: old date/time, 3: new date/time */
						__( "سلام %1\$s،\n\nنوبت مشتری شما از %2\$s به %3\$s تغییر یافت.\n\nBeauClick", 'beauclick-booking' ),
						$provider->display_name,
						$old_when,
						$new_when
					)
				);
			}
		}
	}

	/**
	 * BeauClick is Jalali-first -- a Gregorian date_i18n() string in a
	 * transactional email is exactly the class of bug this project's
	 * global date audit exists to fix. slot_start is already a site-local
	 * wall-clock MySQL datetime (never raw UTC), which is what
	 * JalaliDate::format() expects.
	 */
	private function format_when( string $mysql_datetime ): string {
		return JalaliDate::format( $mysql_datetime, true );
	}
}
