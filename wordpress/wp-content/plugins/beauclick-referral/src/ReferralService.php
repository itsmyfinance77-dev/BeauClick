<?php
declare( strict_types=1 );

namespace BeauClick\Referral;

/**
 * The referral domain's single service — code lifecycle, attribution,
 * qualification, and reward. Every reward goes through
 * `beauclick_loyalty()->ledger()->award()`, the exact same ledger every
 * other earning path (booking completion, reviews, shop orders) already
 * uses — no second points system. Idempotency is enforced at the database
 * layer wherever it matters (UNIQUE keys), the same discipline
 * beauclick-loyalty's own EarningRules and beauclick-notifications'
 * NotificationService already established, not re-invented here.
 */
final class ReferralService {

	/** Unambiguous charset: no 0/O/1/I, so a shared code is easy to read/type correctly. */
	private const CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	private const CODE_LENGTH = 8;

	/**
	 * Lazily creates a user's permanent referral code on first request —
	 * not pre-generated for every account on activation (most accounts will
	 * never share one). The `user_id` UNIQUE key is what makes a second
	 * concurrent call safe: a losing INSERT IGNORE just falls through to
	 * re-reading the row the winning request just created.
	 */
	public function get_or_create_code( int $user_id ): string {
		global $wpdb;

		$existing = $wpdb->get_var(
			$wpdb->prepare( "SELECT code FROM {$wpdb->prefix}bc_referral_codes WHERE user_id = %d", $user_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( $existing ) {
			return $existing;
		}

		for ( $attempt = 0; $attempt < 5; $attempt++ ) {
			$code = self::generate_code();
			$wpdb->query(
				$wpdb->prepare(
					"INSERT IGNORE INTO {$wpdb->prefix}bc_referral_codes (user_id, code, created_at) VALUES (%d, %s, %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					$user_id,
					$code,
					current_time( 'mysql' )
				)
			);

			$existing = $wpdb->get_var(
				$wpdb->prepare( "SELECT code FROM {$wpdb->prefix}bc_referral_codes WHERE user_id = %d", $user_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			);
			if ( $existing ) {
				return $existing;
			}
			// $existing still empty means the INSERT IGNORE was itself
			// silently dropped by the `code` UNIQUE key (an astronomically
			// unlikely random collision, not the user_id race above, which
			// is already handled by the re-read) -- retry with a fresh code.
		}

		throw new \RuntimeException( 'Could not generate a unique referral code after 5 attempts.' );
	}

	public static function generate_code(): string {
		$code = '';
		for ( $i = 0; $i < self::CODE_LENGTH; $i++ ) {
			$code .= self::CODE_CHARS[ random_int( 0, strlen( self::CODE_CHARS ) - 1 ) ];
		}
		return $code;
	}

	public function code_owner( string $code ): ?int {
		global $wpdb;
		$user_id = $wpdb->get_var(
			$wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_referral_codes WHERE code = %s", strtoupper( $code ) ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		return $user_id ? (int) $user_id : null;
	}

	/**
	 * Attributes a new account to whoever owns $code. Self-referral is
	 * prevented BY CONSTRUCTION, not a runtime check that could have a
	 * bug: a code only exists for an account that already exists (created
	 * via get_or_create_code()), and this method is only ever called from
	 * AttributionListener::on_account_registered() for a genuinely NEW
	 * account — an existing user can never have applied their own code to
	 * themselves, because they never go through account creation again.
	 * The `referee_user_id` UNIQUE key is what stops REPLAY: a user who
	 * already has a referral row (from this or any other code) cannot be
	 * attributed a second time, ever.
	 */
	public function attribute( string $code, int $referee_user_id ): bool {
		global $wpdb;

		$referrer_id = $this->code_owner( $code );
		if ( ! $referrer_id || $referrer_id === $referee_user_id ) {
			return false;
		}

		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->prefix}bc_referrals (referrer_user_id, referee_user_id, code_used, status, created_at) VALUES (%d, %d, %s, 'pending', %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$referrer_id,
				$referee_user_id,
				strtoupper( $code ),
				current_time( 'mysql' )
			)
		);
		if ( ! $inserted ) {
			return false; // referee_user_id already claimed by an earlier referral.
		}

		$referral_id = (int) $wpdb->insert_id;
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'referral_signup_attributed', 'referral', $referral_id, $referee_user_id );
		}

		return true;
	}

	/**
	 * Called from QualificationListener whenever a referee completes a
	 * booking or a shop/B2B order. Safe to call repeatedly for the same
	 * user (e.g. a booking completion followed later by a shop order) —
	 * after the first successful qualification there is no longer a
	 * 'pending' row for that referee, so every later call is a no-op.
	 * The status-guarded UPDATE (`WHERE status = 'pending'`) is what makes
	 * this atomic under a genuine race (two qualifying events arriving
	 * near-simultaneously) rather than relying on the SELECT above alone.
	 */
	public function qualify( int $referee_user_id ): void {
		global $wpdb;

		$referral = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT id, referrer_user_id FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d AND status = 'pending'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$referee_user_id
			),
			ARRAY_A
		);
		if ( ! $referral ) {
			return;
		}

		$referral_id = (int) $referral['id'];
		$updated     = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_referrals SET status = 'qualified', qualified_at = %s WHERE id = %d AND status = 'pending'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				current_time( 'mysql' ),
				$referral_id
			)
		);
		if ( ! $updated ) {
			return; // Lost a genuine race to a concurrent qualifying event -- already handled by the winner.
		}

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'referral_qualified', 'referral', $referral_id, $referee_user_id );
		}

		$this->reward( $referral_id, (int) $referral['referrer_user_id'], $referee_user_id );
	}

	/**
	 * "Give one, get one" — both sides of a qualifying referral are
	 * rewarded, via the existing loyalty ledger exclusively. has_awarded()
	 * pre-checks plus the ledger's own UNIQUE (reference_type,
	 * reference_id, reason) index (see LoyaltyLedger) make each of the two
	 * awards idempotent even if reward() were ever somehow invoked twice
	 * for the same referral.
	 */
	private function reward( int $referral_id, int $referrer_id, int $referee_id ): void {
		global $wpdb;

		if ( ! function_exists( 'beauclick_loyalty' ) ) {
			return;
		}

		$ledger           = beauclick_loyalty()->ledger();
		$referrer_points  = ReferralConfig::referrer_reward_points();
		$referee_points   = ReferralConfig::referee_reward_points();

		if ( ! $ledger->has_awarded( 'referral', $referral_id, 'referral_referrer_reward' ) ) {
			$ledger->award( $referrer_id, $referrer_points, 'referral_referrer_reward', 'referral', $referral_id );
		}
		if ( ! $ledger->has_awarded( 'referral', $referral_id, 'referral_referee_reward' ) ) {
			$ledger->award( $referee_id, $referee_points, 'referral_referee_reward', 'referral', $referral_id );
		}

		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_referrals SET status = 'rewarded', rewarded_at = %s WHERE id = %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				current_time( 'mysql' ),
				$referral_id
			)
		);

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log(
				'referral_rewarded',
				'referral',
				$referral_id,
				null,
				[ 'referrerPoints' => $referrer_points, 'refereePoints' => $referee_points ]
			);
		}

		$this->notify_reward( $referral_id, $referrer_id, $referrer_points );
		$this->notify_reward( $referral_id, $referee_id, $referee_points );
	}

	private function notify_reward( int $referral_id, int $user_id, int $points ): void {
		if ( ! function_exists( 'beauclick_notifications' ) ) {
			return;
		}
		beauclick_notifications()->notify(
			'referral',
			\BeauClick\Notifications\Templates\TemplateRegistry::REFERRAL_REWARDED,
			$user_id,
			[ 'points' => $points ],
			'referral',
			$referral_id
		);
	}

	/** @return array{code:string, shareUrl:string, referredCount:int, qualifiedCount:int, rewardedCount:int, pointsEarned:int} */
	public function summary_for_user( int $user_id ): array {
		global $wpdb;

		$code = $this->get_or_create_code( $user_id );

		$counts = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT COUNT(*) AS total, SUM(status IN ('qualified','rewarded')) AS qualified, SUM(status = 'rewarded') AS rewarded FROM {$wpdb->prefix}bc_referrals WHERE referrer_user_id = %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$user_id
			),
			ARRAY_A
		);

		$points_earned = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COALESCE(SUM(points), 0) FROM {$wpdb->prefix}bc_loyalty_points WHERE user_id = %d AND reference_type = 'referral' AND reason = 'referral_referrer_reward'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$user_id
			)
		);

		return [
			'code'           => $code,
			'shareUrl'       => add_query_arg( 'ref', $code, home_url( '/auth/' ) ),
			'referredCount'  => (int) ( $counts['total'] ?? 0 ),
			'qualifiedCount' => (int) ( $counts['qualified'] ?? 0 ),
			'rewardedCount'  => (int) ( $counts['rewarded'] ?? 0 ),
			'pointsEarned'   => $points_earned,
		];
	}
}
