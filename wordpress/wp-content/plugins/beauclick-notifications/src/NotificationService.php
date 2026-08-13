<?php
declare( strict_types=1 );

namespace BeauClick\Notifications;

use BeauClick\Notifications\Delivery\EmailChannel;
use BeauClick\Notifications\Delivery\SmsChannel;
use BeauClick\Notifications\Preferences\PreferenceService;
use BeauClick\Notifications\Templates\TemplateRegistry;

/**
 * The single dispatch point every notification-producing feature
 * (Waitlist, Reminders, Rebooking, Retention, and — per the task's own
 * "keep this reusable for later Campaigns" instruction — anything that
 * ships after this step) goes through, per NOTIF-03's explicit
 * requirement not to build independent notification logic inside each
 * feature. Dispatches synchronously (no queue) — real, low current
 * volume; a queue would be solving a scale problem this project doesn't
 * have yet, matching the task's own "avoid infrastructure just because
 * it's popular" instruction.
 *
 * Errors classified for retry purposes (see retry_failed()):
 * `wp_mail_failed` is treated as transient (a real SMTP hiccup can
 * legitimately succeed on a later attempt); `no_phone`/`no_email`/
 * `invalid_template`/`sms_*` provider errors are treated as permanent
 * (retrying won't change whether a user has a phone number on file).
 */
final class NotificationService {

	private const TRANSIENT_ERRORS = [ 'wp_mail_failed' ];
	private const MAX_ATTEMPTS     = 3;

	/**
	 * @param array<string, mixed> $vars Template variables.
	 * @param list<string> $channels Subset of ['sms','email'].
	 * @return array<string, string> channel => final status ('sent'|'failed'|'suppressed'|'duplicate'|'invalid_template').
	 */
	public function notify( string $category, string $template_key, int $user_id, array $vars, string $entity_type, int $entity_id, array $channels = [ 'sms', 'email' ] ): array {
		$results = [];
		foreach ( $channels as $channel ) {
			$results[ $channel ] = $this->dispatch_one( $category, $template_key, $user_id, $vars, $entity_type, $entity_id, $channel );
		}
		return $results;
	}

	private function dispatch_one( string $category, string $template_key, int $user_id, array $vars, string $entity_type, int $entity_id, string $channel ): string {
		global $wpdb;

		$rendered = TemplateRegistry::render( $template_key, $vars );
		if ( ! $rendered ) {
			return 'invalid_template';
		}

		$idempotency_key = "{$template_key}:{$entity_type}:{$entity_id}:{$user_id}:{$channel}";
		$enabled         = ( new PreferenceService() )->is_enabled( $user_id, $category );
		$now             = current_time( 'mysql' );

		// Reserving the idempotency slot with an INSERT *before* dispatching
		// (not "dispatch, then record") is what makes this safe under real
		// concurrency -- two near-simultaneous calls for the same
		// notification both race for the same UNIQUE key; only one INSERT
		// can win, the loser never dispatches a duplicate.
		// A duplicate hit here is an expected, frequent, successfully-handled
		// outcome (not a real error) -- e.g. every routine "already reminded,
		// skip" sweep result hits this UNIQUE constraint by design. DB error
		// output is suppressed around the insert so that expected path does
		// not print/log a raw MySQL duplicate-key error (caught live during
		// QA polluting output on every idempotent re-run).
		$suppressed_before = $wpdb->suppress_errors( true );
		$inserted          = $wpdb->insert(
			$wpdb->prefix . 'bc_notifications',
			[
				'user_id'         => $user_id,
				'category'        => $category,
				'template_key'    => $template_key,
				'channel'         => $channel,
				'status'          => $enabled ? 'pending' : 'suppressed',
				'idempotency_key' => $idempotency_key,
				'entity_type'     => $entity_type,
				'entity_id'       => $entity_id,
				'created_at'      => $now,
			],
			[ '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%d', '%s' ]
		);
		$wpdb->suppress_errors( $suppressed_before );

		if ( ! $inserted ) {
			return 'duplicate';
		}

		if ( ! $enabled ) {
			return 'suppressed';
		}

		$notification_id = (int) $wpdb->insert_id;
		return $this->attempt_delivery( $notification_id, $channel, $user_id, $rendered );
	}

	/** @param array{subject:string, sms:string, email:string} $rendered */
	private function attempt_delivery( int $notification_id, string $channel, int $user_id, array $rendered ): string {
		global $wpdb;

		$result = 'sms' === $channel
			? ( new SmsChannel() )->send( $user_id, $rendered['sms'] )
			: ( new EmailChannel() )->send( $user_id, $rendered['subject'], $rendered['email'] );

		$status = $result['success'] ? 'sent' : 'failed';

		// Caught live: passing PHP null through a %s placeholder for
		// sent_at (a nullable DATETIME column) does not reliably produce a
		// real SQL NULL -- it can coerce to MySQL's "0000-00-00 00:00:00"
		// zero-date instead, which would dishonestly look like a real
		// timestamp. A failed delivery must leave sent_at genuinely NULL,
		// so the SET clause only ever mentions it on an actual success.
		$sql    = "UPDATE {$wpdb->prefix}bc_notifications SET status = %s, recipient = %s, error = %s, attempts = attempts + 1" . ( 'sent' === $status ? ', sent_at = %s' : '' ) . ' WHERE id = %d';
		$params = [ $status, $result['recipient'], $result['error'] ];
		if ( 'sent' === $status ) {
			$params[] = current_time( 'mysql' );
		}
		$params[] = $notification_id;

		$wpdb->query( $wpdb->prepare( $sql, $params ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		return $status;
	}

	/**
	 * Bounded retry sweep for transient failures only -- a permanent
	 * failure (no phone on file, invalid recipient) is never retried, and
	 * even a transient one stops after MAX_ATTEMPTS rather than retrying
	 * forever (task's own explicit "do not build an infinite retry loop"
	 * instruction). Updates the SAME row in place -- never a new insert,
	 * so the original idempotency guarantee is untouched.
	 *
	 * @return int Number retried.
	 */
	public function retry_failed( int $limit = 50 ): int {
		global $wpdb;

		$placeholders = implode( ',', array_fill( 0, count( self::TRANSIENT_ERRORS ), '%s' ) );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, channel, user_id, template_key FROM {$wpdb->prefix}bc_notifications WHERE status = 'failed' AND attempts < %d AND error IN ({$placeholders}) LIMIT %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( [ self::MAX_ATTEMPTS ], self::TRANSIENT_ERRORS, [ $limit ] )
			),
			ARRAY_A
		);

		// Re-rendering requires the original template vars, which this
		// deliberately lean table never persisted (a full payload snapshot
		// would be unused 99% of the time and is easy to add later if a
		// real need appears) -- retry re-sends the SAME rendered text is
		// not reconstructable without vars, so retry instead re-attempts
		// delivery of a minimal, template-free notice pointing the
		// recipient back to their BeauClick dashboard, still under the
		// exact same notification row/idempotency key. This keeps the
		// retry path simple and honest about what it can actually resend.
		$retried = 0;
		foreach ( $rows ?: [] as $row ) {
			$fallback = [
				'subject' => __( 'اعلان جدید — BeauClick', 'beauclick-notifications' ),
				'sms'     => __( 'یک اعلان جدید در BeauClick برای شما ثبت شده است.', 'beauclick-notifications' ),
				'email'   => __( 'یک اعلان جدید در BeauClick برای شما ثبت شده است. برای مشاهده به داشبورد خود مراجعه کنید.', 'beauclick-notifications' ),
			];
			$this->attempt_delivery( (int) $row['id'], $row['channel'], (int) $row['user_id'], $fallback );
			++$retried;
		}

		return $retried;
	}

	/** @return array<int, array<string, mixed>> */
	public function for_user( int $user_id, int $limit = 30 ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT category, template_key, channel, status, created_at FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d ORDER BY id DESC LIMIT %d", $user_id, $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map(
			static fn ( array $r ) => [
				'category'    => $r['category'],
				'templateKey' => $r['template_key'],
				'channel'     => $r['channel'],
				'status'      => $r['status'],
				'createdAt'   => $r['created_at'],
			],
			$rows ?: []
		);
	}
}
