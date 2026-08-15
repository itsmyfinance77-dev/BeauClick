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

$avatar_url = bc_mockup_image_url( $provider_id );
$cover_meta = get_post_meta( $provider_id, '_bc_mockup_cover', true );
$cover_url  = is_string( $cover_meta ) && preg_match( '/^[a-z0-9\-]+\.svg$/', $cover_meta )
	? get_stylesheet_directory_uri() . '/assets/mockups/' . $cover_meta
	: null;
?>

<?php if ( $cover_url ) : ?>
	<div style="aspect-ratio:16/5; background-image:url('<?php echo esc_url( $cover_url ); ?>'); background-size:cover; background-position:center;"></div>
<?php else : ?>
	<div class="bc-placeholder-image" style="aspect-ratio:16/5;background:linear-gradient(135deg, oklch(0.3 0.06 290), oklch(0.55 0.1 330));"></div>
<?php endif; ?>

<div class="bc-container bc-section">
	<div style="display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap; margin-top:-48px;">
		<?php if ( $avatar_url ) : ?>
			<img src="<?php echo esc_url( $avatar_url ); ?>" alt="" width="96" height="96" style="width:96px; height:96px; border-radius:24px; object-fit:cover; border:4px solid var(--bc-color-surface); flex-shrink:0; display:block;" />
		<?php else : ?>
			<div style="width:96px; height:96px; border-radius:24px; background:var(--bc-gradient-brand); border:4px solid var(--bc-color-surface); flex-shrink:0;"></div>
		<?php endif; ?>

		<div style="flex:1; min-width:240px; padding-top:8px;">
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

		<div style="display:flex; gap:8px; padding-top:8px;">
			<button type="button" class="bc-btn bc-btn--primary" data-bc-book-trigger data-provider-id="<?php echo esc_attr( $provider_id ); ?>"><?php esc_html_e( 'رزرو نوبت', 'beauclick' ); ?></button>
			<?php if ( is_user_logged_in() && get_current_user_id() !== $owner_id ) : ?>
				<button type="button" class="bc-btn bc-btn--outline" data-bc-chat-open data-counterpart-id="<?php echo esc_attr( $owner_id ); ?>"><?php esc_html_e( 'پیام', 'beauclick' ); ?></button>
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
		<div class="bc-empty-state">
			<img src="<?php echo esc_url( get_stylesheet_directory_uri() . '/assets/mockups/empty-illustration.svg' ); ?>" alt="" width="100" height="80" style="width:100px; height:80px; margin:0 auto 12px;" />
			<p class="bc-empty-state__title"><?php esc_html_e( 'این بخش در نسخه بعدی محصول تکمیل می‌شود.', 'beauclick' ); ?></p>
		</div>
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
