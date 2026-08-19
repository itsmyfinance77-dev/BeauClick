<?php
/**
 * Professional Profile — a personal-brand page, not a plain listing (design
 * handoff §3). Portfolio tab still renders an honest empty state (no
 * portfolio-item upload UI yet); reviews are real as of Phase 11.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

the_post();
$provider_id = get_the_ID();
$index_row   = bc_get_provider_index_row( $provider_id );
$services    = bc_get_provider_services( $provider_id );
$specialties = wp_get_post_terms( $provider_id, 'bc_specialty', [ 'fields' => 'names' ] );
$city_name   = bc_get_city_name( ! empty( $index_row['city_id'] ) ? (int) $index_row['city_id'] : null );
$district_name = bc_get_district_name( ! empty( $index_row['district_id'] ) ? (int) $index_row['district_id'] : null );
$location    = trim( implode( '، ', array_filter( [ $city_name, $district_name ] ) ) );
$verified    = 'verified' === get_post_meta( $provider_id, '_bc_verification_status', true );
$owner_id    = (int) get_post_field( 'post_author', $provider_id );

if ( function_exists( 'beauclick_core' ) ) {
	beauclick_core()->events()->log( 'profile_view', 'provider', $provider_id, get_current_user_id() ?: null );
}

$reviews = class_exists( \BeauClick\Reviews\Reviews\ReviewService::class )
	? ( new \BeauClick\Reviews\Reviews\ReviewService() )->for_provider( $provider_id )
	: [];

// V2.4 Step 22: real portfolio items, replacing this section's own
// long-standing "این بخش در نسخه بعدی محصول تکمیل می‌شود" placeholder --
// PortfolioController (beauclick-marketplace) now lets a professional
// actually add these; this is simply the public read side finally reading
// them back, the same real-attachment shape MarketplaceController::detail()
// already reads for the REST API.
$portfolio_items = get_posts(
	[
		'post_type'      => \BeauClick\Marketplace\PostTypes\Registrar::PORTFOLIO_ITEM,
		'post_parent'    => $provider_id,
		'post_status'    => 'publish',
		'posts_per_page' => -1,
	]
);

$is_wishlisted = is_user_logged_in() && class_exists( \BeauClick\Marketplace\Wishlist\WishlistService::class )
	? ( new \BeauClick\Marketplace\Wishlist\WishlistService() )->contains( get_current_user_id(), $provider_id )
	: false;

if ( is_user_logged_in() ) {
	bc_enqueue_app_bundle( 'wishlist-button' );
}

$avatar_url = bc_mockup_image_url( $provider_id );
$cover_meta = get_post_meta( $provider_id, '_bc_mockup_cover', true );
$cover_url  = is_string( $cover_meta ) && preg_match( '/^[a-z0-9\-]+\.svg$/', $cover_meta )
	? get_stylesheet_directory_uri() . '/assets/mockups/' . $cover_meta
	: null;
?>

<?php if ( $cover_url ) : ?>
	<div class="bc-profile-hero__cover" style="background-image:url('<?php echo esc_url( $cover_url ); ?>');"></div>
<?php else : ?>
	<div class="bc-profile-hero__cover bc-placeholder-image" style="background:linear-gradient(135deg, oklch(0.3 0.06 290), oklch(0.55 0.1 330));"></div>
<?php endif; ?>

<div class="bc-container bc-section">
	<div class="bc-profile-hero__header">
		<?php if ( $avatar_url ) : ?>
			<img src="<?php echo esc_url( $avatar_url ); ?>" alt="" width="96" height="96" class="bc-profile-hero__avatar" />
		<?php else : ?>
			<div class="bc-profile-hero__avatar-fallback"></div>
		<?php endif; ?>

		<div class="bc-profile-hero__info">
			<div style="display:flex; align-items:center; gap:8px;">
				<h1 style="margin:0; font-size:24px;"><?php the_title(); ?></h1>
				<?php if ( $verified ) : ?><span class="bc-badge bc-badge--verified" title="<?php esc_attr_e( 'این پروفایل توسط BeauClick بررسی و تأیید شده است.', 'beauclick' ); ?>">تایید‌شده</span><?php endif; ?>
			</div>
			<p class="bc-provider-card__meta">
				<?php echo esc_html( implode( ' · ', $specialties ) ); ?>
				<?php if ( $location ) : ?> · <?php echo esc_html( $location ); ?><?php endif; ?>
			</p>
			<?php if ( $index_row ) : ?>
				<span class="bc-rating bc-numeric">
					<span class="bc-rating__star" aria-hidden="true">★</span>
					<span><?php echo esc_html( bc_format_rating( (float) $index_row['rating_avg'] ) ); ?></span>
					<span class="bc-rating__count">(<?php echo esc_html( bc_persian_digits( (int) $index_row['review_count'] ) ); ?> نظر)</span>
				</span>
			<?php endif; ?>
		</div>

		<div class="bc-profile-hero__actions">
			<button type="button" class="bc-btn bc-btn--primary" data-bc-book-trigger data-provider-id="<?php echo esc_attr( $provider_id ); ?>"><?php esc_html_e( 'رزرو نوبت', 'beauclick' ); ?></button>
			<?php if ( is_user_logged_in() && get_current_user_id() !== $owner_id ) : ?>
				<button type="button" class="bc-btn bc-btn--outline" data-bc-chat-open data-counterpart-id="<?php echo esc_attr( $owner_id ); ?>"><?php esc_html_e( 'پیام', 'beauclick' ); ?></button>
				<button
					type="button"
					class="bc-btn bc-btn--outline bc-wishlist-btn<?php echo $is_wishlisted ? ' bc-wishlist-btn--active' : ''; ?>"
					data-bc-wishlist-toggle
					data-provider-id="<?php echo esc_attr( $provider_id ); ?>"
					data-wishlisted="<?php echo $is_wishlisted ? 'true' : 'false'; ?>"
					aria-pressed="<?php echo $is_wishlisted ? 'true' : 'false'; ?>"
				>
					<span aria-hidden="true"><?php echo $is_wishlisted ? '♥' : '♡'; ?></span>
					<span data-bc-wishlist-label><?php echo $is_wishlisted ? esc_html__( 'در علاقه‌مندی‌ها', 'beauclick' ) : esc_html__( 'افزودن به علاقه‌مندی‌ها', 'beauclick' ); ?></span>
				</button>
			<?php elseif ( ! is_user_logged_in() ) : ?>
				<a href="<?php echo esc_url( home_url( '/auth/' ) ); ?>" class="bc-btn bc-btn--outline"><?php esc_html_e( 'پیام', 'beauclick' ); ?></a>
			<?php endif; ?>
		</div>
	</div>

	<div class="bc-section">
		<h2 class="bc-section__title"><?php esc_html_e( 'درباره', 'beauclick' ); ?></h2>
		<div><?php the_content(); ?></div>
	</div>

	<div class="bc-section">
		<h2 class="bc-section__title"><?php esc_html_e( 'خدمات', 'beauclick' ); ?></h2>
		<?php if ( $services ) : ?>
			<div style="display:flex; flex-direction:column; gap:12px;">
				<?php foreach ( $services as $service ) : ?>
					<?php
					$duration = (int) get_post_meta( $service->ID, '_bc_duration_minutes', true );
					$price    = (int) get_post_meta( $service->ID, '_bc_price', true );
					?>
					<div class="bc-card" style="padding:16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
						<div>
							<strong><?php echo esc_html( $service->post_title ); ?></strong>
							<?php if ( $duration ) : ?>
								<p class="bc-provider-card__meta bc-numeric"><?php echo esc_html( bc_persian_digits( $duration ) ); ?> <?php esc_html_e( 'دقیقه', 'beauclick' ); ?></p>
							<?php endif; ?>
						</div>
						<div style="display:flex; align-items:center; gap:12px;">
							<span class="bc-price bc-numeric">
								<span class="bc-price__amount"><?php echo esc_html( bc_format_toman( $price ) ); ?></span>
								<span class="bc-price__unit"><?php esc_html_e( 'تومان', 'beauclick' ); ?></span>
							</span>
							<button type="button" class="bc-btn bc-btn--outline" data-bc-book-trigger data-provider-id="<?php echo esc_attr( $provider_id ); ?>" data-service-id="<?php echo esc_attr( $service->ID ); ?>"><?php esc_html_e( 'رزرو', 'beauclick' ); ?></button>
						</div>
					</div>
				<?php endforeach; ?>
			</div>
		<?php else : ?>
			<div class="bc-empty-state"><p class="bc-empty-state__title"><?php esc_html_e( 'هنوز خدمتی ثبت نشده است.', 'beauclick' ); ?></p></div>
		<?php endif; ?>
	</div>

	<div class="bc-section">
		<h2 class="bc-section__title"><?php esc_html_e( 'نمونه‌کار', 'beauclick' ); ?></h2>
		<?php if ( $portfolio_items ) : ?>
			<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:12px;">
				<?php foreach ( $portfolio_items as $item ) : ?>
					<?php $image_url = get_the_post_thumbnail_url( $item->ID, 'large' ); ?>
					<?php if ( $image_url ) : ?>
						<img src="<?php echo esc_url( $image_url ); ?>" alt="<?php echo esc_attr( $item->post_title ); ?>" style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:12px; display:block;" />
					<?php endif; ?>
				<?php endforeach; ?>
			</div>
		<?php else : ?>
			<div class="bc-empty-state">
				<img src="<?php echo esc_url( get_stylesheet_directory_uri() . '/assets/mockups/empty-illustration.svg' ); ?>" alt="" width="100" height="80" style="width:100px; height:80px; margin:0 auto 12px;" />
				<p class="bc-empty-state__title"><?php esc_html_e( 'هنوز نمونه‌کاری ثبت نشده است.', 'beauclick' ); ?></p>
			</div>
		<?php endif; ?>
	</div>

	<div class="bc-section">
		<h2 class="bc-section__title"><?php esc_html_e( 'نظرات', 'beauclick' ); ?></h2>
		<?php if ( $reviews ) : ?>
			<div style="display:flex; flex-direction:column; gap:12px;">
				<?php foreach ( $reviews as $review ) : ?>
					<div class="bc-card" style="padding:16px;">
						<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
							<strong><?php echo esc_html( $review['authorName'] ); ?></strong>
							<span class="bc-rating bc-numeric"><span class="bc-rating__star" aria-hidden="true">★</span> <?php echo esc_html( bc_persian_digits( $review['rating'] ) ); ?></span>
						</div>
						<?php if ( $review['body'] ) : ?>
							<p style="margin:8px 0 0; color:var(--bc-color-ink-soft);"><?php echo esc_html( $review['body'] ); ?></p>
						<?php endif; ?>
						<?php if ( $review['response'] ) : ?>
							<div style="margin-top:12px; padding:12px; background:var(--bc-color-surface-tint); border-radius:12px;">
								<strong style="font-size:13px;"><?php esc_html_e( 'پاسخ متخصص', 'beauclick' ); ?></strong>
								<p style="margin:4px 0 0; font-size:13px; color:var(--bc-color-ink-soft);"><?php echo esc_html( $review['response'] ); ?></p>
							</div>
						<?php endif; ?>
					</div>
				<?php endforeach; ?>
			</div>
		<?php else : ?>
			<div class="bc-empty-state"><p class="bc-empty-state__title"><?php esc_html_e( 'هنوز نظری ثبت نشده است.', 'beauclick' ); ?></p></div>
		<?php endif; ?>
	</div>
</div>

<?php
get_footer();
