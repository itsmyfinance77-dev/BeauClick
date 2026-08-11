<?php
/**
 * Marketplace — professional discovery. Server-renders the initial result
 * set filtered by $_GET (city_id, specialty_id) for SEO/no-JS correctness;
 * the marketplace-filters React island (Phase 4 follow-up) hydrates over
 * the chip rows for instant client-side re-filtering without a page reload.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

$city_id     = isset( $_GET['city_id'] ) ? absint( $_GET['city_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
$specialty_id = isset( $_GET['specialty_id'] ) ? absint( $_GET['specialty_id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

$providers  = bc_get_providers( [ 'city_id' => $city_id, 'specialty_id' => $specialty_id, 'limit' => 48 ] );
$cities      = bc_get_launched_cities();
$specialties = bc_get_specialties();
$city_label  = $city_id ? bc_get_city_name( $city_id ) : '';
?>

<div class="bc-container bc-section">
	<h1 class="bc-section__title">
		<?php
		echo $city_label
			? sprintf( /* translators: %s: city name */ esc_html__( 'متخصص در %s', 'beauclick' ), esc_html( $city_label ) )
			: esc_html__( 'متخصص در سراسر ایران', 'beauclick' );
		?>
	</h1>
	<p class="bc-provider-card__meta bc-numeric"><?php echo esc_html( bc_persian_digits( count( $providers ) ) ); ?> <?php esc_html_e( 'نتیجه', 'beauclick' ); ?></p>

	<div id="bc-marketplace-filters-root" class="bc-chip-row" data-selected-city="<?php echo esc_attr( $city_id ); ?>" data-selected-specialty="<?php echo esc_attr( $specialty_id ); ?>">
		<a href="<?php echo esc_url( home_url( '/marketplace/' ) ); ?>" class="bc-chip bc-chip--accent <?php echo ! $city_id ? 'bc-chip--active' : ''; ?>"><?php esc_html_e( 'همه شهرها', 'beauclick' ); ?></a>
		<?php foreach ( $cities as $city ) : ?>
			<a href="<?php echo esc_url( add_query_arg( 'city_id', $city['id'], home_url( '/marketplace/' ) ) ); ?>" class="bc-chip bc-chip--accent <?php echo ( (int) $city_id === (int) $city['id'] ) ? 'bc-chip--active' : ''; ?>"><?php echo esc_html( $city['name_fa'] ); ?></a>
		<?php endforeach; ?>
	</div>

	<div class="bc-chip-row">
		<a href="<?php echo esc_url( remove_query_arg( 'specialty_id' ) ); ?>" class="bc-chip bc-chip--primary <?php echo ! $specialty_id ? 'bc-chip--active' : ''; ?>"><?php esc_html_e( 'همه تخصص‌ها', 'beauclick' ); ?></a>
		<?php foreach ( $specialties as $term ) : ?>
			<a href="<?php echo esc_url( add_query_arg( 'specialty_id', $term->term_id ) ); ?>" class="bc-chip bc-chip--primary <?php echo ( (int) $specialty_id === (int) $term->term_id ) ? 'bc-chip--active' : ''; ?>"><?php echo esc_html( $term->name ); ?></a>
		<?php endforeach; ?>
	</div>

	<?php if ( $providers ) : ?>
		<div class="bc-grid">
			<?php foreach ( $providers as $provider ) : ?>
				<?php get_template_part( 'template-parts/provider-card', null, [ 'provider' => $provider ] ); ?>
			<?php endforeach; ?>
		</div>
	<?php else : ?>
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'متخصصی با این فیلتر پیدا نشد…', 'beauclick' ); ?></p>
			<a href="<?php echo esc_url( home_url( '/marketplace/' ) ); ?>" class="bc-btn bc-btn--outline"><?php esc_html_e( 'پاک کردن فیلترها', 'beauclick' ); ?></a>
		</div>
	<?php endif; ?>
</div>

<?php
get_footer();
