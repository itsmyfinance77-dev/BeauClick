<?php
/**
 * Fallback template — WordPress requires a theme to have index.php.
 * Real content lives in front-page.php, page-marketplace.php, etc.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();
?>
<div class="bc-container bc-section">
	<?php if ( have_posts() ) : ?>
		<?php while ( have_posts() ) : the_post(); ?>
			<article <?php post_class(); ?>>
				<h1><?php the_title(); ?></h1>
				<?php the_content(); ?>
			</article>
		<?php endwhile; ?>
	<?php else : ?>
		<p><?php esc_html_e( 'موردی یافت نشد.', 'beauclick' ); ?></p>
	<?php endif; ?>
</div>
<?php
get_footer();
