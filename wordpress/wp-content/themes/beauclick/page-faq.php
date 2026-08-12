<?php
/**
 * FAQ — content is stored as JSON (see LegalPages::faq_content()) and
 * rendered as a native <details>/<summary> accordion: keyboard-operable
 * and screen-reader-correct with zero JavaScript, matching the task's own
 * "do not over-engineer" instruction for this step.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

$faqs = have_posts() ? ( static function (): array {
	the_post();
	$decoded = json_decode( get_the_content(), true );
	return is_array( $decoded ) ? $decoded : [];
} )() : [];
?>
<div class="bc-container bc-legal">
	<header class="bc-legal__header">
		<h1><?php esc_html_e( 'سوالات متداول', 'beauclick' ); ?></h1>
	</header>

	<?php if ( $faqs ) : ?>
		<div class="bc-faq">
			<?php foreach ( $faqs as $item ) : ?>
				<details class="bc-faq__item">
					<summary class="bc-faq__question"><?php echo esc_html( $item['q'] ?? '' ); ?></summary>
					<p class="bc-faq__answer"><?php echo esc_html( $item['a'] ?? '' ); ?></p>
				</details>
			<?php endforeach; ?>
		</div>
	<?php else : ?>
		<p><?php esc_html_e( 'در حال حاضر سوالی ثبت نشده است.', 'beauclick' ); ?></p>
	<?php endif; ?>

	<p class="bc-legal__updated" style="margin-top: 24px;">
		<?php
		printf(
			/* translators: %s: contact page link */
			wp_kses( __( 'سوالی که پاسخش را اینجا پیدا نکردید؟ از صفحه %s بپرسید.', 'beauclick' ), [ 'a' => [ 'href' => [] ] ] ),
			'<a href="' . esc_url( home_url( '/contact/' ) ) . '">' . esc_html__( 'تماس با ما', 'beauclick' ) . '</a>'
		);
		?>
	</p>
</div>
<?php
wp_enqueue_style( 'beauclick-legal', BEAUCLICK_THEME_URI . '/assets/css/legal.css', [], BEAUCLICK_THEME_VERSION );
get_footer();
