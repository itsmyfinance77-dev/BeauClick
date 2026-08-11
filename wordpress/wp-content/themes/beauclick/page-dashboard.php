<?php
/**
 * Dashboard — one route, two experiences (design handoff §7). Which React
 * bundle mounts depends on the logged-in user's role: bc_professional/
 * bc_business get the provider-side dashboard (bookings, services, stats
 * earned from their own listings); everyone else gets the customer
 * dashboard (their own orders/bookings/account). Logged-out visitors get a
 * login prompt — there is nothing to show them.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

$user = wp_get_current_user();
$is_provider = $user->exists() && array_intersect( [ 'bc_professional', 'bc_business' ], (array) $user->roles );
?>

<div class="bc-container bc-section">
	<?php if ( ! $user->exists() ) : ?>
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'برای مشاهده داشبورد ابتدا وارد حساب کاربری خود شوید.', 'beauclick' ); ?></p>
			<a href="<?php echo esc_url( wp_login_url( get_permalink() ) ); ?>" class="bc-btn bc-btn--primary"><?php esc_html_e( 'ورود', 'beauclick' ); ?></a>
		</div>
	<?php elseif ( $is_provider ) : ?>
		<?php bc_enqueue_app_bundle( 'dashboard-professional' ); ?>
		<div id="bc-dashboard-professional-root"></div>
	<?php else : ?>
		<?php bc_enqueue_app_bundle( 'dashboard-customer' ); ?>
		<div id="bc-dashboard-customer-root"></div>
	<?php endif; ?>
</div>

<?php
get_footer();
