<?php
/**
 * @package BeauClick\Theme
 */

declare( strict_types=1 );
?>
</main>

<footer class="bc-footer">
	<div class="bc-container">
		<p>© <?php echo esc_html( gmdate( 'Y' ) ); ?> BeauClick — <?php esc_html_e( 'زیبایی، هوشمندتر از همیشه', 'beauclick' ); ?></p>
	</div>
</footer>

<?php
// Global overlay mount points, present on every page per the design
// handoff (booking modal, cart drawer, AI panel, chat all overlay the
// current page rather than living on a route of their own).
bc_enqueue_app_bundle( 'booking' );
bc_enqueue_app_bundle( 'cart' );
bc_enqueue_app_bundle( 'ai-assistant' );
if ( is_user_logged_in() ) {
	bc_enqueue_app_bundle( 'chat' );
}
?>
<div id="bc-booking-root"></div>
<div id="bc-cart-root"></div>
<div id="bc-ai-assistant-root"></div>
<?php if ( is_user_logged_in() ) : ?>
	<div id="bc-chat-root"></div>
<?php endif; ?>

<?php wp_footer(); ?>
</body>
</html>
