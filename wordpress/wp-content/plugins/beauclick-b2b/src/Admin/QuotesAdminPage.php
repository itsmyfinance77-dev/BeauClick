<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Admin;

use BeauClick\B2B\Business\QuoteService;
use BeauClick\Core\Admin\Shell\AdminShell;

/**
 * V2.3 Step 20: `B2BController::submit_quote_prices()` (the admin
 * quote-back/counter-quote REST route) has existed since Phase 7 with no
 * UI ever calling it at all — not even a wp-admin one, unlike the account
 * approve/reject action this plugin already had a page for. Classic
 * wp-admin form + admin-post.php, same low-frequency-internal-tooling
 * convention as AccountsAdminPage — calls QuoteService directly (not the
 * REST route), same shape as AccountsAdminPage calling BusinessAccountService
 * directly rather than looping back through its own REST controller.
 */
final class QuotesAdminPage {

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 10 );
		add_action( 'admin_post_bc_b2b_quote_price', [ $this, 'handle_submit_price' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'پیش‌فاکتورهای B2B', 'beauclick-b2b' ),
			__( 'پیش‌فاکتورهای B2B', 'beauclick-b2b' ),
			'bc_manage_platform',
			'beauclick-b2b-quotes',
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		global $wpdb;
		$quotes = $wpdb->get_results(
			"SELECT q.*, a.business_name FROM {$wpdb->prefix}bc_quotes q
			 INNER JOIN {$wpdb->prefix}bc_business_accounts a ON a.id = q.business_account_id
			 ORDER BY (q.status = 'requested') DESC, q.created_at DESC LIMIT 100",
			ARRAY_A
		);

		AdminShell::header(
			__( 'پیش‌فاکتورهای B2B', 'beauclick-b2b' ),
			null,
			[ [ 'label' => __( 'پیش‌فاکتورهای B2B', 'beauclick-b2b' ) ] ]
		);

		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'انجام شد.', 'beauclick-b2b' ) );
		}

		if ( ! $quotes ) {
			AdminShell::empty_state( __( 'هیچ درخواست پیش‌فاکتوری ثبت نشده است.', 'beauclick-b2b' ) );
			AdminShell::footer();
			return;
		}

		$status_labels = [
			QuoteService::STATUS_REQUESTED => __( 'در انتظار قیمت‌گذاری', 'beauclick-b2b' ),
			QuoteService::STATUS_QUOTED    => __( 'قیمت‌گذاری شده', 'beauclick-b2b' ),
			QuoteService::STATUS_ACCEPTED  => __( 'تأیید شده', 'beauclick-b2b' ),
			QuoteService::STATUS_EXPIRED   => __( 'منقضی‌شده', 'beauclick-b2b' ),
		];

		foreach ( $quotes as $quote ) {
			$items = json_decode( (string) $quote['items'], true ) ?: [];
			echo '<div class="bc-card" style="padding:16px; margin-bottom:16px;">';
			echo '<strong>' . esc_html( $quote['business_name'] ) . '</strong> — <span>' . esc_html( $status_labels[ $quote['status'] ] ?? $quote['status'] ) . '</span>';

			echo '<table class="wp-list-table widefat" style="margin-top:8px;"><thead><tr>';
			echo '<th>' . esc_html__( 'محصول', 'beauclick-b2b' ) . '</th>';
			echo '<th>' . esc_html__( 'تعداد', 'beauclick-b2b' ) . '</th>';
			echo '<th>' . esc_html__( 'قیمت واحد (تومان)', 'beauclick-b2b' ) . '</th>';
			echo '</tr></thead><tbody>';

			$is_editable = QuoteService::STATUS_REQUESTED === $quote['status'];

			if ( $is_editable ) {
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
				wp_nonce_field( 'bc_b2b_quote_' . $quote['id'] );
				echo '<input type="hidden" name="action" value="bc_b2b_quote_price">';
				echo '<input type="hidden" name="quote_id" value="' . esc_attr( $quote['id'] ) . '">';
			}

			foreach ( $items as $item ) {
				$product = wc_get_product( (int) $item['product_id'] );
				echo '<tr>';
				echo '<td>' . esc_html( $product ? $product->get_name() : '#' . $item['product_id'] ) . '<input type="hidden" name="product_id[]" value="' . esc_attr( $item['product_id'] ) . '"></td>';
				echo '<td class="bc-numeric">' . esc_html( (string) $item['quantity'] ) . '<input type="hidden" name="quantity[]" value="' . esc_attr( $item['quantity'] ) . '"></td>';
				if ( $is_editable ) {
					echo '<td><input type="number" min="0" step="1" name="price[]" required style="width:120px;"></td>';
				} else {
					echo '<td class="bc-numeric">' . esc_html( isset( $item['price'] ) ? (string) $item['price'] : '—' ) . '</td>';
				}
				echo '</tr>';
			}
			echo '</tbody></table>';

			if ( $is_editable ) {
				echo '<div style="margin-top:8px; display:flex; gap:12px; align-items:end;">';
				echo '<label>' . esc_html__( 'مهلت پذیرش (اختیاری)', 'beauclick-b2b' ) . '<br><input type="datetime-local" name="expires_at"></label>';
				echo '<button type="submit" class="button button-primary">' . esc_html__( 'ثبت قیمت و ارسال پیش‌فاکتور', 'beauclick-b2b' ) . '</button>';
				echo '</div></form>';
			} elseif ( $quote['quoted_total'] ) {
				echo '<p class="bc-numeric">' . esc_html__( 'جمع کل:', 'beauclick-b2b' ) . ' ' . esc_html( number_format_i18n( (float) $quote['quoted_total'] ) ) . ' ' . esc_html__( 'تومان', 'beauclick-b2b' ) . '</p>';
			}

			echo '</div>';
		}

		AdminShell::footer();
	}

	public function handle_submit_price(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-b2b' ), 403 );
		}
		$quote_id = isset( $_POST['quote_id'] ) ? (int) $_POST['quote_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_b2b_quote_' . $quote_id );

		$product_ids = array_map( 'intval', (array) ( $_POST['product_id'] ?? [] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$quantities  = array_map( 'intval', (array) ( $_POST['quantity'] ?? [] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$prices      = array_map( 'intval', (array) ( $_POST['price'] ?? [] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing

		$items = [];
		foreach ( $product_ids as $i => $product_id ) {
			$items[] = [
				'product_id' => $product_id,
				'quantity'   => $quantities[ $i ] ?? 0,
				'price'      => $prices[ $i ] ?? 0,
			];
		}

		$expires_at_raw = isset( $_POST['expires_at'] ) ? sanitize_text_field( wp_unslash( $_POST['expires_at'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$expires_at     = $expires_at_raw ? gmdate( 'Y-m-d H:i:s', strtotime( $expires_at_raw ) ) : null;

		$this->price_and_log( $quote_id, $items, $expires_at );

		wp_safe_redirect( admin_url( 'admin.php?page=beauclick-b2b-quotes&bc_notice=1' ) );
		exit;
	}

	/**
	 * Extracted from handle_submit_price() so it's directly testable — that
	 * method ends in wp_safe_redirect()+exit and can't run inside a test
	 * process, same split AccountsAdminPage::approve_and_log() already
	 * established for this plugin.
	 *
	 * @param list<array{product_id:int, quantity:int, price:int}> $items
	 */
	public function price_and_log( int $quote_id, array $items, ?string $expires_at ): bool {
		$before = ( new QuoteService() )->find( $quote_id );
		$ok     = ( new QuoteService() )->submit_quote_prices( $quote_id, $items, $expires_at );

		if ( $ok && function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record(
				'b2b_quote_priced',
				'quote',
				$quote_id,
				get_current_user_id(),
				$before ? [ 'status' => $before['status'] ] : null,
				[ 'status' => QuoteService::STATUS_QUOTED ]
			);
		}

		return $ok;
	}
}
