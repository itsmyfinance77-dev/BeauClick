<?php
/**
 * Professional Profile — a personal-brand page, not a plain listing (design
 * handoff §3). Portfolio/reviews tabs render honest empty states for now —
 * beauclick-reviews doesn't exist yet (Phase 11) and portfolio-item upload
 * UI doesn't either — rather than faking content.
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
?>

<div class="bc-placeholder-image" style="aspect-ratio:16/5;background:linear-gradient(135deg, oklch(0.3 0.06 290), oklch(0.55 0.1 330));"></div>

<div class="bc-container bc-section">
	<div style="display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap; margin-top:-48px;">
		<div style="width:96px; height:96px; border-radius:24px; background:var(--bc-gradient-brand); border:4px solid var(--bc-color-surface); flex-shrink:0;"></div>

		<div style="flex:1; min-width:240px; padding-top:8px;">
			<div style="display:flex; align-items:center; gap:8px;">
				<h1 style="margin:0; font-size:24px;"><?php the_title(); ?></h1>
				<?php if ( $verified ) : ?><span class="bc-badge bc-badge--verified">تایید‌شده</span><?php endif; ?>
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
			<button type="button" class="bc-btn bc-btn--outline" disabled title="<?php esc_attr_e( 'در نسخه بعدی محصول تکمیل می‌شود', 'beauclick' ); ?>"><?php esc_html_e( 'پیام', 'beauclick' ); ?></button>
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
		<div class="bc-empty-state"><p class="bc-empty-state__title"><?php esc_html_e( 'این بخش در نسخه بعدی محصول تکمیل می‌شود.', 'beauclick' ); ?></p></div>
	</div>

	<div class="bc-section">
		<h2 class="bc-section__title"><?php esc_html_e( 'نظرات', 'beauclick' ); ?></h2>
		<div class="bc-empty-state"><p class="bc-empty-state__title"><?php esc_html_e( 'هنوز نظری ثبت نشده است.', 'beauclick' ); ?></p></div>
	</div>
</div>

<?php
get_footer();
