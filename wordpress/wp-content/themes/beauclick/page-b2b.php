<?php
/**
 * BeauClick Business — a distinct, operational experience for wholesale
 * buyers (design handoff §6), never a discounted reskin of the B2C Shop.
 * Server-rendered: dark hero, generic tier table (illustrative — real
 * per-product tiers show inline on each catalog card), and the wholesale
 * catalog gated by the viewer's actual business-account approval status.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

$user_id = get_current_user_id();
$account = null;
if ( $user_id ) {
	global $wpdb;
	$account = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_business_accounts WHERE user_id = %d", $user_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
}
$is_approved = $account && 'approved' === $account['approval_status'];
?>

<section class="bc-banner bc-banner--b2b" style="border-radius:0; padding-block:56px;">
	<div class="bc-container">
		<span class="bc-hero__kicker" style="color:white; opacity:.8;">BeauClick Business</span>
		<h1 style="font-size:32px; margin:12px 0 8px; color:white;"><?php esc_html_e( 'خرید عمده محصولات آرایشی و بهداشتی', 'beauclick' ); ?></h1>
		<p style="max-width:60ch; opacity:.85; margin:0 0 24px;"><?php esc_html_e( 'برای سالن‌ها، کلینیک‌ها و متخصصان مستقل — تخفیف پلکانی، پیش‌فاکتور و مدیریت سفارش‌های عمده.', 'beauclick' ); ?></p>
		<div class="bc-hero__stats bc-numeric" style="margin-bottom:24px;">
			<div class="bc-hero__stat" style="color:white;"><strong style="color:white;"><?php echo esc_html( bc_persian_digits( 4 ) ); ?></strong><span style="opacity:.7;"><?php esc_html_e( 'سطح تخفیف پلکانی', 'beauclick' ); ?></span></div>
			<div class="bc-hero__stat" style="color:white;"><strong style="color:white;">۳۰٪</strong><span style="opacity:.7;"><?php esc_html_e( 'تا سقف تخفیف عمده', 'beauclick' ); ?></span></div>
		</div>
		<?php if ( ! $is_approved ) : ?>
			<a href="#bc-b2b-apply" class="bc-btn bc-btn--light"><?php esc_html_e( 'ثبت‌نام به‌عنوان خریدار عمده', 'beauclick' ); ?></a>
		<?php endif; ?>
	</div>
</section>

<div class="bc-container bc-section">
	<h2 class="bc-section__title"><?php esc_html_e( 'نمونه تخفیف پلکانی', 'beauclick' ); ?></h2>
	<div style="overflow-x:auto;">
		<table style="width:100%; border-collapse:collapse; min-width:480px;">
			<thead>
				<tr style="background:var(--bc-color-surface-tint); text-align:start;">
					<th style="padding:12px 16px;"><?php esc_html_e( 'تعداد', 'beauclick' ); ?></th>
					<th style="padding:12px 16px;"><?php esc_html_e( 'تخفیف نسبت به قیمت خرده‌فروشی', 'beauclick' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<tr style="border-bottom:1px solid var(--bc-color-line);"><td style="padding:12px 16px;" class="bc-numeric">۱ – ۹</td><td style="padding:12px 16px;"><?php esc_html_e( 'قیمت پایه', 'beauclick' ); ?></td></tr>
				<tr style="border-bottom:1px solid var(--bc-color-line);"><td style="padding:12px 16px;" class="bc-numeric">۱۰ – ۴۹</td><td style="padding:12px 16px;">۱۰٪</td></tr>
				<tr style="border-bottom:1px solid var(--bc-color-line); background:var(--bc-color-primary-soft);"><td style="padding:12px 16px;" class="bc-numeric">۵۰ – ۹۹ <span class="bc-badge bc-badge--recommended"><?php esc_html_e( 'پیشنهادی', 'beauclick' ); ?></span></td><td style="padding:12px 16px;">۲۰٪</td></tr>
				<tr><td style="padding:12px 16px;" class="bc-numeric">۱۰۰+</td><td style="padding:12px 16px;">۳۰٪</td></tr>
			</tbody>
		</table>
	</div>
</div>

<?php if ( ! $user_id ) : ?>
	<div class="bc-container bc-section">
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'برای درخواست همکاری تجاری ابتدا وارد حساب کاربری خود شوید.', 'beauclick' ); ?></p>
			<a href="<?php echo esc_url( wp_login_url( get_permalink() ) ); ?>" class="bc-btn bc-btn--primary"><?php esc_html_e( 'ورود', 'beauclick' ); ?></a>
		</div>
	</div>

<?php elseif ( ! $account ) : ?>
	<div class="bc-container bc-section" id="bc-b2b-apply">
		<h2 class="bc-section__title"><?php esc_html_e( 'ثبت‌نام به‌عنوان خریدار عمده', 'beauclick' ); ?></h2>
		<form id="bc-b2b-apply-form" class="bc-card" style="padding:20px; max-width:480px; display:flex; flex-direction:column; gap:12px;">
			<input class="bc-input" type="text" name="business_name" placeholder="<?php esc_attr_e( 'نام کسب‌وکار', 'beauclick' ); ?>" required>
			<input class="bc-input" type="text" name="license" placeholder="<?php esc_attr_e( 'شماره جواز کسب (اختیاری)', 'beauclick' ); ?>">
			<input class="bc-input" type="tel" name="phone" placeholder="<?php esc_attr_e( 'شماره تماس', 'beauclick' ); ?>">
			<button type="submit" class="bc-btn bc-btn--primary"><?php esc_html_e( 'ارسال درخواست', 'beauclick' ); ?></button>
			<p id="bc-b2b-apply-status" style="margin:0; font-size:13px;"></p>
		</form>
	</div>
	<script>
	document.getElementById('bc-b2b-apply-form').addEventListener('submit', function (e) {
		e.preventDefault();
		var form = e.target, status = document.getElementById('bc-b2b-apply-status');
		var data = { business_name: form.business_name.value, license: form.license.value, phone: form.phone.value };
		status.textContent = '<?php echo esc_js( __( 'در حال ارسال…', 'beauclick' ) ); ?>';
		fetch( ( window.BeauClick && window.BeauClick.restUrl ) + '/b2b/apply', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': window.BeauClick.nonce },
			body: JSON.stringify( data ),
		} ).then( function ( r ) { return r.json(); } ).then( function ( res ) {
			status.textContent = res.error ? res.error.message : '<?php echo esc_js( __( 'درخواست شما ثبت شد و در انتظار بررسی است.', 'beauclick' ) ); ?>';
			if ( ! res.error ) { form.style.display = 'none'; }
		} ).catch( function () { status.textContent = '<?php echo esc_js( __( 'خطایی رخ داد.', 'beauclick' ) ); ?>'; } );
	} );
	</script>

<?php elseif ( 'pending' === $account['approval_status'] ) : ?>
	<div class="bc-container bc-section">
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'درخواست همکاری تجاری شما در حال بررسی است.', 'beauclick' ); ?></p>
		</div>
	</div>

<?php elseif ( 'rejected' === $account['approval_status'] ) : ?>
	<div class="bc-container bc-section">
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'درخواست همکاری تجاری شما تأیید نشد.', 'beauclick' ); ?></p>
			<?php if ( ! empty( $account['rejection_reason'] ) ) : ?>
				<p style="color:var(--bc-color-ink-faint); font-size:13px;"><?php echo esc_html( $account['rejection_reason'] ); ?></p>
			<?php endif; ?>
		</div>
	</div>

<?php else : ?>
	<div class="bc-container bc-section">
		<h2 class="bc-section__title"><?php esc_html_e( 'کاتالوگ عمده', 'beauclick' ); ?></h2>
		<?php
		$products = wc_get_products( [ 'status' => 'publish', 'limit' => 48 ] );
		$engine   = new \BeauClick\B2B\Pricing\TierPricingEngine();
		$wholesale_products = array_filter( $products, static fn ( $p ) => $engine->has_tiers( $p->get_id() ) );
		?>
		<?php if ( $wholesale_products ) : ?>
			<div class="bc-grid">
				<?php foreach ( $wholesale_products as $product ) : ?>
					<?php
					$tiers = $engine->get_tiers( $product->get_id() );
					$moq   = $engine->moq( $product->get_id() );
					$best  = end( $tiers );
					?>
					<div class="bc-card" style="padding:16px;">
						<strong><?php echo esc_html( $product->get_name() ); ?></strong>
						<p class="bc-provider-card__meta"><?php echo esc_html( sprintf( __( 'حداقل سفارش: %s عدد', 'beauclick' ), bc_persian_digits( $moq ) ) ); ?></p>
						<div style="display:flex; align-items:baseline; gap:8px; margin:8px 0;">
							<span class="bc-price__old bc-numeric"><?php echo esc_html( bc_format_toman( (int) $product->get_regular_price() ) ); ?></span>
							<strong class="bc-numeric" style="color:var(--bc-color-primary);"><?php echo esc_html( bc_format_toman( $best['price'] ) ); ?> <?php esc_html_e( 'تومان', 'beauclick' ); ?></strong>
						</div>
						<button type="button" class="bc-btn bc-btn--primary" style="width:100%;" data-bc-add-to-cart data-product-id="<?php echo esc_attr( $product->get_id() ); ?>" data-quantity="<?php echo esc_attr( $moq ); ?>">
							<?php esc_html_e( 'افزودن به سفارش عمده', 'beauclick' ); ?>
						</button>
					</div>
				<?php endforeach; ?>
			</div>
		<?php else : ?>
			<div class="bc-empty-state"><p class="bc-empty-state__title"><?php esc_html_e( 'هنوز محصولی برای فروش عمده تعریف نشده است.', 'beauclick' ); ?></p></div>
		<?php endif; ?>
	</div>
<?php endif; ?>

<?php
get_footer();
