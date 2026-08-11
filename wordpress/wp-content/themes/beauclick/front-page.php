<?php
/**
 * Home — hero, category chips, provider rail, AI promo, product grid, B2B
 * banner. Per design handoff §1. Interactive bits (search, AI panel, cart)
 * are React islands mounted onto these containers in later phases; this
 * template server-renders the real content around them now.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

get_header();

$featured_providers = bc_get_providers( [ 'limit' => 4 ] );
$specialties         = bc_get_specialties();
?>

<section class="bc-hero bc-container">
	<div>
		<span class="bc-hero__kicker"><?php esc_html_e( 'مارکت‌پلیس هوشمند زیبایی', 'beauclick' ); ?></span>
		<h1 class="bc-hero__title"><?php esc_html_e( 'متخصص زیبایی موردنظرت رو پیدا کن، نوبت بگیر', 'beauclick' ); ?></h1>
		<p class="bc-hero__subhead"><?php esc_html_e( 'جست‌وجو، مقایسه و رزرو آنلاین بهترین متخصصان و مراکز زیبایی در سراسر ایران — به‌همراه فروشگاه محصولات و دستیار هوشمند زیبایی.', 'beauclick' ); ?></p>

		<form class="bc-hero__search" role="search" action="<?php echo esc_url( home_url( '/marketplace/' ) ); ?>" method="get">
			<input type="search" name="q" class="bc-input bc-input--bare" placeholder="<?php esc_attr_e( 'مثلاً: میکاپ عروس در یزد…', 'beauclick' ); ?>">
			<button type="submit" class="bc-btn bc-btn--primary"><?php esc_html_e( 'جست‌وجو', 'beauclick' ); ?></button>
		</form>

		<div class="bc-hero__stats bc-numeric">
			<div class="bc-hero__stat"><strong><?php echo esc_html( bc_persian_digits( 31 ) ); ?></strong><span><?php esc_html_e( 'استان تحت پوشش', 'beauclick' ); ?></span></div>
			<div class="bc-hero__stat"><strong><?php echo esc_html( bc_persian_digits( count( $featured_providers ) ) ); ?>+</strong><span><?php esc_html_e( 'متخصص فعال', 'beauclick' ); ?></span></div>
			<div class="bc-hero__stat"><strong>۲۴/۷</strong><span><?php esc_html_e( 'رزرو آنلاین', 'beauclick' ); ?></span></div>
		</div>
	</div>
	<div class="bc-hero__visual" aria-hidden="true"></div>
</section>

<?php if ( $specialties ) : ?>
<section class="bc-container bc-section">
	<div class="bc-chip-row">
		<?php foreach ( $specialties as $term ) : ?>
			<a href="<?php echo esc_url( add_query_arg( 'specialty_id', $term->term_id, home_url( '/marketplace/' ) ) ); ?>" class="bc-chip bc-chip--primary"><?php echo esc_html( $term->name ); ?></a>
		<?php endforeach; ?>
	</div>
</section>
<?php endif; ?>

<section class="bc-container bc-section">
	<h2 class="bc-section__title"><?php esc_html_e( 'متخصصان پیشنهادی', 'beauclick' ); ?></h2>
	<?php if ( $featured_providers ) : ?>
		<div class="bc-grid">
			<?php foreach ( $featured_providers as $provider ) : ?>
				<?php get_template_part( 'template-parts/provider-card', null, [ 'provider' => $provider ] ); ?>
			<?php endforeach; ?>
		</div>
	<?php else : ?>
		<div class="bc-empty-state">
			<p class="bc-empty-state__title"><?php esc_html_e( 'هنوز متخصصی ثبت نشده است.', 'beauclick' ); ?></p>
		</div>
	<?php endif; ?>
</section>

<section class="bc-container bc-section">
	<div class="bc-banner bc-banner--ai">
		<h3><?php esc_html_e( 'دستیار هوشمند زیبایی BeauClick', 'beauclick' ); ?></h3>
		<p><?php esc_html_e( 'بپرس چه روتینی برای پوستت مناسبه یا برای مراسم عروسی چه خدماتی لازم داری — دستیار هوشمند بهت پیشنهاد می‌ده.', 'beauclick' ); ?></p>
		<button type="button" class="bc-btn bc-btn--light" id="bc-ai-fab-trigger"><?php esc_html_e( 'شروع گفتگو با AI', 'beauclick' ); ?></button>
	</div>
</section>

<section class="bc-container bc-section">
	<div class="bc-banner bc-banner--b2b">
		<h3><?php esc_html_e( 'BeauClick Business — خرید عمده برای سالن‌ها و کلینیک‌ها', 'beauclick' ); ?></h3>
		<p><?php esc_html_e( 'تخفیف پلکانی، پیش‌فاکتور و مدیریت سفارش‌های عمده محصولات آرایشی و بهداشتی.', 'beauclick' ); ?></p>
		<a href="<?php echo esc_url( home_url( '/b2b/' ) ); ?>" class="bc-btn bc-btn--light"><?php esc_html_e( 'مشاهده کاتالوگ عمده', 'beauclick' ); ?></a>
	</div>
</section>

<?php
get_footer();
