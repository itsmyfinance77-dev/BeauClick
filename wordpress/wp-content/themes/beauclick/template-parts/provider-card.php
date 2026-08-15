<?php
/**
 * Renders one provider card from a wp_bc_provider_index row.
 * Expects $args['provider'].
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

$provider = $args['provider'] ?? null;
if ( ! $provider ) {
	return;
}

$city_name = bc_get_city_name( $provider['city_id'] ? (int) $provider['city_id'] : null );
$district_name = bc_get_district_name( $provider['district_id'] ? (int) $provider['district_id'] : null );
$location  = trim( implode( '، ', array_filter( [ $city_name, $district_name ] ) ) );

// V2.0 Step 3: truthful, pre-computed explanation phrases only -- never the
// raw internal ranking_score. At most 2, kept as plain small text (not a
// row of badges) per the roadmap's own "do not overdo badges" guidance.
$ranking_reasons = ! empty( $provider['ranking_signals'] ) && class_exists( \BeauClick\Marketplace\Ranking\RankingPresenter::class )
	? array_slice( \BeauClick\Marketplace\Ranking\RankingPresenter::explain( (array) json_decode( (string) $provider['ranking_signals'], true ) ), 0, 2 )
	: [];

$image_url = bc_mockup_image_url( (int) $provider['provider_id'] );
?>
<div class="bc-card bc-card--hoverable">
	<a href="<?php echo esc_url( bc_provider_permalink( $provider ) ); ?>" style="display:block;">
		<?php if ( $image_url ) : ?>
			<img src="<?php echo esc_url( $image_url ); ?>" alt="" style="width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:var(--bc-radius-card) var(--bc-radius-card) 0 0; display:block;" width="400" height="300" loading="lazy" />
		<?php else : ?>
			<div class="bc-placeholder-image" style="aspect-ratio:4/3;background:linear-gradient(135deg, oklch(0.9 0.04 290), oklch(0.8 0.06 330));">
				<span><?php esc_html_e( 'تصویر متخصص', 'beauclick' ); ?></span>
			</div>
		<?php endif; ?>
	</a>
	<div class="bc-provider-card__body">
		<div class="bc-provider-card__name-row">
			<a href="<?php echo esc_url( bc_provider_permalink( $provider ) ); ?>" style="color:inherit;">
				<strong><?php echo esc_html( $provider['name'] ); ?></strong>
			</a>
			<?php if ( ! empty( $provider['verified'] ) ) : ?>
				<span class="bc-badge bc-badge--verified" title="<?php esc_attr_e( 'این پروفایل توسط BeauClick بررسی و تأیید شده است.', 'beauclick' ); ?>">✓</span>
			<?php endif; ?>
		</div>

		<?php if ( $location ) : ?>
			<p class="bc-provider-card__meta"><?php echo esc_html( $location ); ?></p>
		<?php endif; ?>

		<span class="bc-rating bc-numeric">
			<span class="bc-rating__star" aria-hidden="true">★</span>
			<span><?php echo esc_html( bc_format_rating( (float) $provider['rating_avg'] ) ); ?></span>
			<span class="bc-rating__count">(<?php echo esc_html( bc_persian_digits( (int) $provider['review_count'] ) ); ?>)</span>
		</span>

		<?php if ( $ranking_reasons ) : ?>
			<p class="bc-provider-card__meta"><?php echo esc_html( implode( ' · ', $ranking_reasons ) ); ?></p>
		<?php endif; ?>

		<div class="bc-provider-card__footer">
			<?php if ( $provider['price_from'] ) : ?>
				<span class="bc-price bc-numeric">
					<span class="bc-price__prefix"><?php esc_html_e( 'شروع از', 'beauclick' ); ?></span>
					<span class="bc-price__amount"><?php echo esc_html( bc_format_toman( (int) $provider['price_from'] ) ); ?></span>
					<span class="bc-price__unit"><?php esc_html_e( 'تومان', 'beauclick' ); ?></span>
				</span>
			<?php endif; ?>
			<button type="button" class="bc-btn bc-btn--outline" data-bc-book-trigger data-provider-id="<?php echo esc_attr( $provider['provider_id'] ); ?>"><?php esc_html_e( 'رزرو نوبت', 'beauclick' ); ?></button>
		</div>
	</div>
</div>
