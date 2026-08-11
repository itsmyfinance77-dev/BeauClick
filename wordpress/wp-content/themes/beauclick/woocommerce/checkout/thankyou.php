<?php
/**
 * BeauClick's thank-you/order-received page — overrides WooCommerce's
 * default template (wp-content/plugins/woocommerce/templates/checkout/thankyou.php)
 * so this reads as BeauClick, not a stock WooCommerce page (review point
 * #6). This is a content fragment, not a full page template — it renders
 * inside the "Checkout" WordPress Page's normal content area (wrapped by
 * this theme's page template, e.g. index.php's .bc-container), so it does
 * NOT call get_header()/get_footer() itself.
 *
 * The important WooCommerce action hooks are preserved (gateway-specific
 * instructions, third-party plugin integrations, order tracking scripts
 * all hook these) — only the visual presentation changes.
 *
 * @var WC_Order|false $order
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;
?>

<div class="bc-order-received">
	<?php if ( $order ) : ?>
		<?php do_action( 'woocommerce_before_thankyou', $order->get_id() ); ?>

		<?php if ( $order->has_status( 'failed' ) ) : ?>
			<div class="bc-empty-state">
				<p class="bc-empty-state__title"><?php esc_html_e( 'پرداخت شما ناموفق بود — لطفاً دوباره تلاش کنید.', 'beauclick' ); ?></p>
				<div style="display:flex; gap:8px; justify-content:center;">
					<a href="<?php echo esc_url( $order->get_checkout_payment_url() ); ?>" class="bc-btn bc-btn--primary"><?php esc_html_e( 'تلاش مجدد برای پرداخت', 'beauclick' ); ?></a>
					<?php if ( is_user_logged_in() ) : ?>
						<a href="<?php echo esc_url( wc_get_page_permalink( 'myaccount' ) ); ?>" class="bc-btn bc-btn--outline"><?php esc_html_e( 'حساب کاربری', 'beauclick' ); ?></a>
					<?php endif; ?>
				</div>
			</div>
		<?php else : ?>
			<div style="text-align:center; padding:32px 0;">
				<div style="width:64px; height:64px; border-radius:50%; background:var(--bc-color-success-soft); color:var(--bc-color-success); display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:32px;">✓</div>
				<h1 style="font-size:24px; margin:0 0 8px;"><?php esc_html_e( 'سفارش شما با موفقیت ثبت شد', 'beauclick' ); ?></h1>
				<p style="color:var(--bc-color-ink-soft); margin:0 0 24px;"><?php esc_html_e( 'جزئیات سفارش برای شما پیامک/ایمیل خواهد شد.', 'beauclick' ); ?></p>

				<div class="bc-card" style="max-width:420px; margin:0 auto; padding:20px; text-align:start;">
					<div class="bc-provider-card__footer" style="margin-top:0;">
						<span class="bc-provider-card__meta"><?php esc_html_e( 'شماره سفارش', 'beauclick' ); ?></span>
						<strong class="bc-numeric"><?php echo esc_html( bc_persian_digits( (string) $order->get_order_number() ) ); ?></strong>
					</div>
					<div class="bc-provider-card__footer">
						<span class="bc-provider-card__meta"><?php esc_html_e( 'تاریخ', 'beauclick' ); ?></span>
						<strong><?php echo esc_html( bc_persian_digits( wc_format_datetime( $order->get_date_created() ) ) ); ?></strong>
					</div>
					<div class="bc-provider-card__footer">
						<span class="bc-provider-card__meta"><?php esc_html_e( 'مبلغ کل', 'beauclick' ); ?></span>
						<strong class="bc-numeric"><?php echo esc_html( bc_format_toman( (int) $order->get_total() ) ); ?> <?php esc_html_e( 'تومان', 'beauclick' ); ?></strong>
					</div>
					<?php if ( $order->get_payment_method_title() ) : ?>
						<div class="bc-provider-card__footer">
							<span class="bc-provider-card__meta"><?php esc_html_e( 'روش پرداخت', 'beauclick' ); ?></span>
							<strong><?php echo wp_kses_post( $order->get_payment_method_title() ); ?></strong>
						</div>
					<?php endif; ?>
				</div>

				<div style="margin-top:24px;">
					<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="bc-btn bc-btn--primary"><?php esc_html_e( 'بازگشت به خانه', 'beauclick' ); ?></a>
				</div>
			</div>
		<?php endif; ?>

		<?php do_action( 'woocommerce_thankyou_' . $order->get_payment_method(), $order->get_id() ); ?>
		<?php do_action( 'woocommerce_thankyou', $order->get_id() ); ?>
	<?php else : ?>
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'سفارشی پیدا نشد.', 'beauclick' ); ?></p>
		</div>
	<?php endif; ?>
</div>
