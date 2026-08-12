<?php
/**
 * Generic WordPress page fallback (previously missing — every plain page
 * fell back to the bare index.php). Styled for long-form Persian content
 * with a heading-derived table of contents and a Jalali "last updated"
 * date — built for V2.1 Step 7 (Legal & Trust Foundation) to serve
 * Privacy/Refund/Terms/About without four near-duplicate templates, but
 * correct for any future plain content page too.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

use BeauClick\Core\Support\JalaliDate;

get_header();
?>
<div class="bc-container bc-legal">
	<?php if ( have_posts() ) : while ( have_posts() ) : the_post(); ?>
		<article <?php post_class( 'bc-legal__article' ); ?>>
			<header class="bc-legal__header">
				<h1><?php the_title(); ?></h1>
				<p class="bc-legal__updated bc-numeric">
					<?php
					printf(
						/* translators: %s: Jalali date */
						esc_html__( 'آخرین به‌روزرسانی: %s', 'beauclick' ),
						esc_html( JalaliDate::format( get_the_modified_date( 'Y-m-d H:i:s' ) ) )
					);
					?>
				</p>
			</header>
			<div class="bc-legal__body">
				<?php the_content(); ?>
			</div>
		</article>
	<?php endwhile; else : ?>
		<p><?php esc_html_e( 'موردی یافت نشد.', 'beauclick' ); ?></p>
	<?php endif; ?>
</div>
<?php
wp_enqueue_style( 'beauclick-legal', BEAUCLICK_THEME_URI . '/assets/css/legal.css', [], BEAUCLICK_THEME_VERSION );
get_footer();
