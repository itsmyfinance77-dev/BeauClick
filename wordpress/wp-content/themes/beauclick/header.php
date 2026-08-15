<?php
/**
 * @package BeauClick\Theme
 */

declare( strict_types=1 );
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>

<header class="bc-header">
	<div class="bc-container bc-header__inner">
		<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="bc-logo">
			<img class="bc-logo__mark" src="<?php echo esc_url( BEAUCLICK_THEME_URI . '/assets/brand/icon-gradient.svg' ); ?>" width="32" height="32" alt="">
			<span>BeauClick</span>
		</a>

		<nav class="bc-nav" aria-label="<?php esc_attr_e( 'Primary', 'beauclick' ); ?>">
			<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="<?php echo is_front_page() ? 'is-active' : ''; ?>"><?php esc_html_e( 'خانه', 'beauclick' ); ?></a>
			<a href="<?php echo esc_url( home_url( '/marketplace/' ) ); ?>" class="<?php echo is_page( 'marketplace' ) ? 'is-active' : ''; ?>"><?php esc_html_e( 'متخصصان', 'beauclick' ); ?></a>
			<a href="<?php echo esc_url( get_permalink( wc_get_page_id( 'shop' ) ) ?: '#' ); ?>"><?php esc_html_e( 'فروشگاه', 'beauclick' ); ?></a>
			<a href="<?php echo esc_url( home_url( '/b2b/' ) ); ?>"><?php esc_html_e( 'همکاری تجاری', 'beauclick' ); ?></a>
			<a href="<?php echo esc_url( home_url( '/dashboard/' ) ); ?>"><?php esc_html_e( 'داشبورد من', 'beauclick' ); ?></a>
		</nav>

		<div class="bc-header__actions">
			<button type="button" class="bc-icon-chip" aria-label="<?php esc_attr_e( 'جستجو', 'beauclick' ); ?>" data-bc-search-open>⌕</button>
			<button type="button" class="bc-icon-chip bc-icon-chip--cart-desktop-only" aria-label="<?php esc_attr_e( 'سبد خرید', 'beauclick' ); ?>" data-bc-cart-open>
				🛍
				<span class="bc-icon-chip__badge bc-numeric" id="bc-cart-count">۰</span>
			</button>
			<?php if ( is_user_logged_in() ) : ?>
				<a href="<?php echo esc_url( home_url( '/dashboard/' ) ); ?>" class="bc-icon-chip" aria-label="<?php esc_attr_e( 'حساب کاربری', 'beauclick' ); ?>">
					<?php echo esc_html( mb_substr( wp_get_current_user()->display_name ?: 'B', 0, 1 ) ); ?>
				</a>
			<?php else : ?>
				<a href="<?php echo esc_url( home_url( '/auth/' ) ); ?>" class="bc-icon-chip" aria-label="<?php esc_attr_e( 'ورود', 'beauclick' ); ?>">↪</a>
			<?php endif; ?>
		</div>
	</div>
</header>

<nav class="bc-bottom-nav" aria-label="<?php esc_attr_e( 'ناوبری موبایل', 'beauclick' ); ?>">
	<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="<?php echo is_front_page() ? 'is-active' : ''; ?>"><?php esc_html_e( 'خانه', 'beauclick' ); ?></a>
	<a href="<?php echo esc_url( home_url( '/marketplace/' ) ); ?>"><?php esc_html_e( 'متخصصان', 'beauclick' ); ?></a>
	<a href="<?php echo esc_url( get_permalink( wc_get_page_id( 'shop' ) ) ?: '#' ); ?>"><?php esc_html_e( 'فروشگاه', 'beauclick' ); ?></a>
	<a href="<?php echo esc_url( home_url( '/dashboard/' ) ); ?>"><?php esc_html_e( 'داشبورد', 'beauclick' ); ?></a>
</nav>

<main id="bc-main">
