<?php
declare( strict_types=1 );

namespace BeauClick\Core\Support;

/**
 * Thin writer for wp_bc_events. Every module logs through this rather than
 * writing to the table directly, so the event shape (and any future
 * validation/throttling) stays in one place.
 *
 * V2.4 Step 25 (event formalization): `EVENT_TYPES` replaces what used to be
 * a docblock-only, unenforced list (V3_GAP_REGISTER.md's own GAP-07 --
 * "no schema, no versioning... documented only in a code comment"). This is
 * deliberately NOT the full versioned event contract/producer-consumer
 * registry GAP-07 describes for V3 -- that's a real, larger, separate
 * undertaking this step does not attempt. What this DOES close, achievable
 * within V2's existing architecture and without new infrastructure: real
 * PHP constants a call site can reference instead of a bare magic string
 * (IDE-checkable, typo-resistant), and a soft, `WP_DEBUG`-only, non-breaking
 * `_doing_it_wrong()` notice when `log()` is called with an event_type
 * outside this registry -- so a genuinely new or misspelled event type gets
 * surfaced to a developer during development, without ever silently
 * dropping the event or breaking a production request. `log()` still
 * accepts any string; this is a soft net, not a hard schema.
 *
 * Compiled by a fresh, direct grep of every real `events()->log(...)` call
 * site across all 17 plugins (not carried forward from this docblock's own
 * prior, since-corrected list) -- including the indirect ones that don't
 * pass a literal string at the `log()` call site itself
 * (`BookingService::transition()`'s own `$event` parameter,
 * `RescheduleService::log_event()`'s own wrapper). `B2B_ACCOUNT_APPROVED`/
 * `B2B_ACCOUNT_REJECTED` cover `BusinessAccountService::set_status()`'s own
 * `"b2b_account_{$status}"` interpolation -- confirmed, by reading that
 * class's own status constants, that `pending` is never reached through
 * this path (the initial application already logs `B2B_ACCOUNT_APPLIED`
 * separately), so exactly these two concrete strings are the real space.
 */
final class EventLogger {

	// Marketplace / discovery
	public const PROFILE_VIEW      = 'profile_view';
	public const SEARCH_PERFORMED  = 'search_performed';
	public const RESPONSE_TIME_SECONDS = 'response_time_seconds';

	// Booking lifecycle
	public const BOOKING_CREATED    = 'booking_created';
	public const BOOKING_CONFIRMED  = 'booking_confirmed';
	public const BOOKING_CANCELLED  = 'booking_cancelled';
	public const BOOKING_COMPLETED  = 'booking_completed';
	public const BOOKING_EXPIRED    = 'booking_expired';
	public const BOOKING_NO_SHOW    = 'booking_no_show';
	public const BOOKING_CONFIRM_AFTER_EXPIRY_CONFLICT = 'booking_confirm_after_expiry_conflict';
	public const BOOKING_RESCHEDULE_REQUESTED  = 'booking_reschedule_requested';
	public const BOOKING_RESCHEDULE_SUCCEEDED  = 'booking_reschedule_succeeded';
	public const BOOKING_RESCHEDULE_FAILED     = 'booking_reschedule_failed';
	public const WAITLIST_JOINED = 'waitlist_joined';

	// Commerce / payments
	public const PRODUCT_VIEW      = 'product_view';
	public const CART_ADD          = 'cart_add';
	public const CHECKOUT_STARTED  = 'checkout_started';
	public const ORDER_COMPLETED   = 'order_completed';
	public const ORDER_REFUNDED    = 'order_refunded';
	public const CAMPAIGN_APPLIED  = 'campaign_applied';

	// Social / content
	public const REVIEW_SUBMITTED  = 'review_submitted';
	public const MESSAGE_SENT      = 'message_sent';

	// AI
	public const AI_RECOMMENDATION_SHOWN   = 'ai_recommendation_shown';
	public const AI_RECOMMENDATION_CLICKED = 'ai_recommendation_clicked';

	// Beauty Journey
	public const GOAL_CREATED = 'goal_created';

	// B2B
	public const B2B_ACCOUNT_APPLIED  = 'b2b_account_applied';
	public const B2B_ACCOUNT_APPROVED = 'b2b_account_approved';
	public const B2B_ACCOUNT_REJECTED = 'b2b_account_rejected';
	public const B2B_QUOTE_REQUESTED  = 'b2b_quote_requested';
	public const B2B_QUOTE_ACCEPTED   = 'b2b_quote_accepted';

	// Referral
	public const REFERRAL_SIGNUP_ATTRIBUTED = 'referral_signup_attributed';
	public const REFERRAL_QUALIFIED         = 'referral_qualified';
	public const REFERRAL_REWARDED          = 'referral_rewarded';

	// Loyalty / membership
	public const MEMBERSHIP_ACTIVATED = 'membership_activated';
	public const MEMBERSHIP_CANCELLED = 'membership_cancelled';
	public const MEMBERSHIP_EXPIRED   = 'membership_expired';

	// Client-triggered UI opens (AnalyticsController::track(), lib/analytics.ts's track())
	public const AI_ASSISTANT_OPENED  = 'ai_assistant_opened';
	public const CRM_OPENED           = 'crm_opened';
	public const JOURNEY_OPENED       = 'journey_opened';
	public const REFERRAL_LINK_SHARED = 'referral_link_shared';

	/** @var string[] Every value above, built once via Reflection so this list can never drift from the constants themselves. */
	private static ?array $known_types = null;

	private static function known_types(): array {
		if ( null === self::$known_types ) {
			self::$known_types = array_values( ( new \ReflectionClass( self::class ) )->getConstants() );
		}
		return self::$known_types;
	}

	public function log( string $event_type, string $entity_type, int $entity_id, ?int $actor_id = null, array $meta = [] ): void {
		if ( function_exists( '_doing_it_wrong' ) && ! in_array( $event_type, self::known_types(), true ) ) {
			// WP_DEBUG-gated (WP core's own _doing_it_wrong() no-ops
			// otherwise) -- a real signal for a developer to add the new
			// event_type to the registry above, never a reason to drop or
			// reject the event itself in production.
			_doing_it_wrong( __METHOD__, sprintf( 'Unregistered event_type "%s" — add it to EventLogger::EVENT_TYPES.', $event_type ), 'V2.4' ); // phpcs:ignore WordPress.WP.DeprecatedFunctions.wp_deprecated_functionFound, WordPress.WP.I18n.MissingArgDomain
		}

		global $wpdb;

		$wpdb->insert(
			$wpdb->prefix . 'bc_events',
			[
				'event_type'  => $event_type,
				'entity_type' => $entity_type,
				'entity_id'   => $entity_id,
				'actor_id'    => $actor_id,
				'meta'        => ! empty( $meta ) ? wp_json_encode( $meta ) : null,
				'created_at'  => current_time( 'mysql' ),
			],
			[ '%s', '%s', '%d', '%d', '%s', '%s' ]
		);
	}

	/**
	 * V2.0 Step 1: a guard for the handful of call sites that react to a
	 * WooCommerce hook without an atomic status-transition guard of their
	 * own (order_completed/order_refunded — see beauclick-payments\Plugin).
	 * Most events here (booking_*, review_submitted) don't need this: they
	 * already log from inside an atomic status transition that itself only
	 * ever succeeds once per real state change, so a second call is a no-op
	 * before it ever reaches log(). profile_view intentionally has no such
	 * guard — every page view is a genuine, distinct event, not a duplicate
	 * to suppress.
	 */
	public function has_logged( string $event_type, string $entity_type, int $entity_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_type = %s AND entity_id = %d LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_type,
				$entity_type,
				$entity_id
			)
		);
	}
}
