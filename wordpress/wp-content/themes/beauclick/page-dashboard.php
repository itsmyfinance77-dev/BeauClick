<?php
/**
 * Dashboard — one route, two experiences (design handoff §7). Which React
 * bundle mounts depends on the logged-in user's role: bc_professional/
 * bc_business get the provider-side dashboard (bookings, services, stats
 * earned from their own listings); everyone else gets the customer
 * dashboard (their own orders/bookings/account). Logged-out visitors get a
 * login prompt — there is nothing to show them.
 *
 * V2.2 Step 16 — an authorized staff member (StaffService) keeps their own
 * WP role ('customer') by design (this minimal model never changes a
 * user's role — see StaffService's own docblock), so the role-only check
 * alone would silently route them to the customer dashboard despite the
 * backend (CrmController/MyAnalyticsController) genuinely authorizing them.
 * Caught during this step's own live verification, not assumed — a real
 * staff member's session was tested end to end and landed on the wrong
 * dashboard before this fix.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

$user = wp_get_current_user();
$is_provider = $user->exists() && array_intersect( [ 'bc_professional', 'bc_business' ], (array) $user->roles );

if ( ! $is_provider && $user->exists() && class_exists( '\BeauClick\Marketplace\Staff\StaffService' ) ) {
	$is_provider = ! empty( ( new \BeauClick\Marketplace\Staff\StaffService() )->provider_ids_for_staff_user( $user->ID ) );
}
?>

<div class="bc-container bc-section">
	<?php if ( ! $user->exists() ) : ?>
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'برای مشاهده داشبورد ابتدا وارد حساب کاربری خود شوید.', 'beauclick' ); ?></p>
			<a href="<?php echo esc_url( home_url( '/auth/' ) ); ?>" class="bc-btn bc-btn--primary"><?php esc_html_e( 'ورود', 'beauclick' ); ?></a>
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
