<?php
/**
 * Contact — a real admin-post.php form (BeauClick\Core\Content\ContactFormHandler),
 * delivering to the site's own real admin_email. No phone number, office
 * address, or support hours are shown here — none are approved/configured
 * yet (Product Gap Register LEGAL-05 stays NEEDS_BUSINESS_DECISION for
 * those specific fields); the form itself is a genuine, working contact
 * path that doesn't depend on them.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

use BeauClick\Core\Content\ContactFormHandler;

get_header();

$status = isset( $_GET['bc_contact'] ) ? sanitize_key( wp_unslash( $_GET['bc_contact'] ) ) : null; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
?>
<div class="bc-container bc-legal">
	<header class="bc-legal__header">
		<h1><?php esc_html_e( 'تماس با ما', 'beauclick' ); ?></h1>
	</header>

	<div class="bc-legal__body">
		<?php if ( have_posts() ) : while ( have_posts() ) : the_post(); ?>
			<?php the_content(); ?>
		<?php endwhile; endif; ?>
	</div>

	<?php if ( 'sent' === $status ) : ?>
		<p class="bc-form-notice bc-form-notice--success" role="status"><?php esc_html_e( 'پیام شما ارسال شد. در اسرع وقت پاسخ خواهیم داد.', 'beauclick' ); ?></p>
	<?php elseif ( 'invalid' === $status ) : ?>
		<p class="bc-form-notice bc-form-notice--error" role="alert"><?php esc_html_e( 'لطفاً همه فیلدها را به‌درستی پر کنید.', 'beauclick' ); ?></p>
	<?php elseif ( 'rate_limited' === $status ) : ?>
		<p class="bc-form-notice bc-form-notice--error" role="alert"><?php esc_html_e( 'تعداد پیام‌های شما بیش از حد مجاز است. لطفاً کمی بعد دوباره تلاش کنید.', 'beauclick' ); ?></p>
	<?php endif; ?>

	<form class="bc-contact-form" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
		<input type="hidden" name="action" value="<?php echo esc_attr( ContactFormHandler::action() ); ?>">
		<?php echo ContactFormHandler::nonce_field(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
		<div class="bc-contact-form__honeypot" aria-hidden="true">
			<label for="bc_website"><?php esc_html_e( 'وب‌سایت', 'beauclick' ); ?></label>
			<input type="text" id="bc_website" name="bc_website" tabindex="-1" autocomplete="off">
		</div>

		<label class="bc-field" for="bc-contact-name">
			<span><?php esc_html_e( 'نام', 'beauclick' ); ?></span>
			<input class="bc-input" type="text" id="bc-contact-name" name="name" required>
		</label>

		<label class="bc-field" for="bc-contact-email">
			<span><?php esc_html_e( 'ایمیل', 'beauclick' ); ?></span>
			<input class="bc-input" type="email" id="bc-contact-email" name="email" required>
		</label>

		<label class="bc-field" for="bc-contact-message">
			<span><?php esc_html_e( 'پیام', 'beauclick' ); ?></span>
			<textarea class="bc-input" id="bc-contact-message" name="message" rows="5" required></textarea>
		</label>

		<button type="submit" class="bc-btn bc-btn--primary"><?php esc_html_e( 'ارسال پیام', 'beauclick' ); ?></button>
	</form>
</div>
<?php
wp_enqueue_style( 'beauclick-legal', BEAUCLICK_THEME_URI . '/assets/css/legal.css', [], BEAUCLICK_THEME_VERSION );
get_footer();
