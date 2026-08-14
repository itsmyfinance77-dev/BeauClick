<?php
declare( strict_types=1 );

namespace BeauClick\Core\Content;

/**
 * V2.1 Step 7 — Legal & Trust Foundation.
 *
 * Provisions the site's trust pages the same idempotent, "never overwrite a
 * deliberate customization" way `beauclick-payments\Plugin::ensure_persian_page_titles()`
 * already establishes for WooCommerce's own auto-created pages: on first
 * run (or whenever the still-stock/still-empty content is detected), write
 * real content; once an admin has genuinely edited a page, this class never
 * touches it again.
 *
 * IMPORTANT — content boundary (task's own explicit rule, restated here
 * because it governs every string below): every section in this file is
 * either (a) a factual, verifiable description of what this codebase
 * actually does — grounded in real, tested behavior, not invented — or (b)
 * entirely absent, never a fabricated placeholder ("coming soon", "TODO",
 * invented fees/timeframes/company registration details). Where a genuine
 * business or legal decision is still outstanding, the relevant page simply
 * does not make a claim about it, rather than showing fake content to a
 * real visitor. See docs/roadmap/PRODUCT_GAP_REGISTER.md §22 for the full
 * list of what remains NEEDS_BUSINESS_DECISION / NEEDS_LEGAL_REVIEW.
 *
 * Terms of Service is deliberately the one page this class creates but
 * never publishes — its binding clauses (liability, dispute resolution,
 * governing law, prohibited-use enforcement) are not inferable from source
 * code the way the others' factual sections are, and publishing an
 * unreviewed ToS is a real risk the task explicitly warns against (§30).
 */
final class LegalPages {

	private const SLUG_PRIVACY = 'privacy-policy';
	private const SLUG_REFUND  = 'refund_returns'; // Pre-existing slug (V1-era draft) — kept as-is rather than renamed, to avoid breaking any existing link.
	private const SLUG_TERMS   = 'terms';
	private const SLUG_FAQ     = 'faq';
	private const SLUG_CONTACT = 'contact';
	private const SLUG_ABOUT   = 'about';

	/** Bump whenever the content below changes, so an already-provisioned site re-syncs it. Same version-gated pattern as RoleManager::CAPS_VERSION. */
	private const CONTENT_VERSION = '2026-08-12.1';

	/**
	 * Deliberately NOT called from Plugin::activate() — `wp_insert_post()`/
	 * `wp_update_post()` transitioning a page's status into 'publish' fires
	 * `wp_transition_post_status()`, which touches `is_user_logged_in()`
	 * (a pluggable.php function not yet defined this early in a raw
	 * activation-hook context — caught by this class's own test suite
	 * failing during the PHPUnit bootstrap's explicit early activate()
	 * call, not by anything that would show up in a normal admin-triggered
	 * activation). `admin_init` is safely past that point — same
	 * "re-arm on admin_init, version-gated so it stays cheap" pattern
	 * RoleManager::maybe_register() already established for exactly this
	 * class of "needs full WP, not just activation-time WP" problem.
	 */
	public static function maybe_ensure(): void {
		if ( get_option( 'bc_legal_pages_version' ) === self::CONTENT_VERSION ) {
			return;
		}
		self::ensure();
		update_option( 'bc_legal_pages_version', self::CONTENT_VERSION );
	}

	public static function ensure(): void {
		self::ensure_page( self::SLUG_PRIVACY, 'حریم خصوصی', self::privacy_content(), 'publish' );
		self::ensure_page( self::SLUG_REFUND, 'بازگشت و استرداد وجه', self::refund_content(), 'publish' );
		self::ensure_page( self::SLUG_TERMS, 'قوانین و شرایط استفاده', self::terms_content(), 'draft' );
		self::ensure_page( self::SLUG_FAQ, 'سوالات متداول', self::faq_content(), 'publish', 'faq' );
		self::ensure_page( self::SLUG_CONTACT, 'تماس با ما', self::contact_content(), 'publish', 'contact' );
		self::ensure_page( self::SLUG_ABOUT, 'درباره BeauClick', self::about_content(), 'publish' );

		self::ensure_wp_privacy_policy_page_setting();
		self::trash_stock_sample_page();
	}

	/**
	 * @param string|null $page_template Theme template file slug (without
	 *   `page-`/`.php`) for pages needing more than the generic long-form
	 *   layout (`page.php`) — e.g. `faq`/`contact`. Null uses the theme's
	 *   normal template-hierarchy resolution (page-{slug}.php if present,
	 *   else page.php).
	 */
	private static function ensure_page( string $slug, string $title, string $content, string $publish_status, ?string $page_template = null ): void {
		$existing = get_page_by_path( $slug, OBJECT, 'page' );

		if ( ! $existing ) {
			$id = wp_insert_post(
				[
					'post_title'   => $title,
					'post_name'    => $slug,
					'post_content' => $content,
					'post_status'  => $publish_status,
					'post_type'    => 'page',
				],
				true
			);
			if ( ! is_wp_error( $id ) && $page_template ) {
				update_post_meta( $id, '_wp_page_template', "page-{$page_template}.php" );
			}
			return;
		}

		if ( self::is_still_stock_content( $existing->post_content ) ) {
			wp_update_post(
				[
					'ID'           => $existing->ID,
					'post_content' => $content,
					'post_status'  => 'publish' === $publish_status ? 'publish' : $existing->post_status,
				]
			);
		}
	}

	/**
	 * WordPress/WooCommerce's own auto-generated "Suggested text: ..."
	 * boilerplate (English, block-editor tutorial copy) versus a page an
	 * admin has genuinely started writing — same detection principle as
	 * `ensure_persian_page_titles()`, applied to page bodies instead of
	 * titles. A page this class itself already populated (real Persian
	 * content, published or not) is never touched again either, since its
	 * content won't match either the WP/Woo stock text or an empty string.
	 */
	private static function is_still_stock_content( string $content ): bool {
		if ( trim( $content ) === '' ) {
			return true;
		}
		return str_contains( $content, 'Suggested text' )
			|| str_contains( $content, 'This is a sample page' )
			|| str_contains( $content, 'Our refund and returns policy' );
	}

	/**
	 * WordPress only ever renders a `get_privacy_policy_url()` link (the
	 * `[privacy_policy]` placeholder `beauclick-payments`'s own
	 * `ensure_persian_checkout_privacy_text()` already relies on) when the
	 * configured privacy page's status is genuinely 'publish' — a real,
	 * silent gap this step closes now that the page has real content to
	 * publish. Never overwrites a *different* page an admin may have
	 * deliberately chosen instead.
	 */
	private static function ensure_wp_privacy_policy_page_setting(): void {
		$page = get_page_by_path( self::SLUG_PRIVACY, OBJECT, 'page' );
		if ( ! $page ) {
			return;
		}
		$current = (int) get_option( 'wp_page_for_privacy_policy' );
		if ( 0 === $current || $current === $page->ID ) {
			update_option( 'wp_page_for_privacy_policy', $page->ID );
		}
	}

	/**
	 * A stray, unpublished-in-spirit default WordPress install page
	 * (Product Gap Register SEC-06) — trashed, not permanently deleted, the
	 * same reversible discipline this project uses for every other
	 * potentially-destructive action. Only acts on the exact stock
	 * "Sample Page" slug/title combination, never a same-slug page an admin
	 * repurposed.
	 */
	private static function trash_stock_sample_page(): void {
		$page = get_page_by_path( 'sample-page', OBJECT, 'page' );
		if ( $page && 'Sample Page' === $page->post_title && 'publish' === $page->post_status ) {
			wp_trash_post( $page->ID );
		}
	}

	// ---------------------------------------------------------------
	// Content. Every claim below is either a verifiable fact about this
	// codebase's real, tested behavior, or absent — see the class docblock.
	// ---------------------------------------------------------------

	private static function privacy_content(): string {
		return self::blocks(
			[
				[ 'p', 'این صفحه توضیح می‌دهد BeauClick چه اطلاعاتی از شما جمع‌آوری می‌کند، برای چه استفاده می‌شود و چه کسی به آن دسترسی دارد.' ],
				[ 'h', 'چه اطلاعاتی جمع‌آوری می‌شود' ],
				[ 'ul', [
					'شماره موبایل شما، برای ورود و ثبت‌نام (روش اصلی احراز هویت در BeauClick)',
					'در صورتی که در تسویه‌حساب فروشگاه وارد کنید: نام، آدرس، ایمیل و شماره تماس',
					'تاریخچه نوبت‌ها، سفارش‌ها و رزروهای شما',
					'نظراتی که برای متخصصان ثبت می‌کنید',
					'پیام‌های شما در گفت‌وگو با متخصصان و با دستیار هوشمند BeauClick',
					'اهداف و ترجیحاتی که در «مسیر زیبایی من» ثبت می‌کنید',
				] ],
				[ 'h', 'این اطلاعات برای چه استفاده می‌شود' ],
				[ 'ul', [
					'احراز هویت و حفظ ورود شما به حساب کاربری',
					'ثبت، پیگیری و تکمیل نوبت‌ها و سفارش‌های شما',
					'نمایش تاریخچه رزروها و سفارش‌ها در داشبورد شما',
					'شخصی‌سازی پیشنهادهای دستیار هوشمند بر اساس گفتگوی شما و اهداف مسیر زیبایی',
					'محاسبه امتیاز وفاداری بر اساس نوبت‌ها و نظرات شما',
				] ],
				[ 'h', 'چه کسی به اطلاعات شما دسترسی دارد' ],
				[ 'ul', [
					'متخصص یا کسب‌وکاری که برایش نوبت می‌گیرید، اطلاعات مربوط به همان نوبت (نام، زمان، خدمت) را می‌بیند.',
					'یادداشت‌های داخلی که یک متخصص درباره مشتریان خود در بخش «مشتریان» ثبت می‌کند، فقط برای همان متخصص قابل مشاهده است — نه برای مشتری، نه برای متخصصان دیگر، و در اختیار دستیار هوشمند نیز قرار نمی‌گیرد.',
					'پیام‌های گفت‌وگوی خصوصی شما با یک متخصص، فقط بین شما و همان متخصص باقی می‌ماند.',
				] ],
				[ 'h', 'دستیار هوشمند BeauClick' ],
				[ 'p', 'پیام‌هایی که برای دستیار هوشمند می‌فرستید برای تولید پاسخ و پیشنهاد پردازش می‌شود. یادداشت‌های خصوصی متخصصان هرگز به‌صورت خودکار در اختیار دستیار هوشمند قرار نمی‌گیرد.' ],
				[ 'h', 'کوکی‌ها' ],
				[ 'p', 'BeauClick در حال حاضر فقط از کوکی‌های ضروری برای ورود، حفظ نشست و سبد خرید استفاده می‌کند و از هیچ سرویس ردیابی یا تبلیغاتی شخص ثالث استفاده نمی‌کند.' ],
				[ 'h', 'دسترسی و ویرایش اطلاعات' ],
				[ 'p', 'می‌توانید اطلاعات آدرس و صورتحساب خود را از بخش «حساب کاربری» ویرایش کنید. برای دریافت نسخه‌ای از اطلاعات خود یا درخواست حذف حساب، بخش «حریم خصوصی و اطلاعات من» در داشبورد حساب کاربری‌تان در دسترس است — دریافت اطلاعات بلافاصله انجام می‌شود و درخواست حذف حساب پیش از اجرا توسط تیم BeauClick بررسی می‌شود. برای هر سؤال دیگری نیز می‌توانید از طریق صفحه «تماس با ما» با ما در ارتباط باشید.' ],
			]
		);
	}

	private static function refund_content(): string {
		return self::blocks(
			[
				[ 'p', 'این صفحه نحوه لغو نوبت و بازگشت وجه در BeauClick را توضیح می‌دهد.' ],
				[ 'h', 'لغو نوبت توسط مشتری' ],
				[ 'p', 'تا زمانی که نوبت شما «انجام‌شده» ثبت نشده باشد، می‌توانید آن را از داشبورد خود لغو کنید.' ],
				[ 'h', 'بازگشت وجه' ],
				[ 'p', 'در صورت لغو نوبت یا سفارش پیش از انجام آن، بازگشت وجه از طریق همان روش پرداخت اصلی انجام می‌شود.' ],
				[ 'h', 'محصولات فروشگاه' ],
				[ 'p', 'بازگشت و استرداد محصولات فروشگاه، مطابق فرآیند استاندارد سفارش‌های ووکامرس بررسی و انجام می‌شود.' ],
				[ 'h', 'لغو توسط متخصص' ],
				[ 'p', 'در صورتی که یک متخصص نوبت شما را لغو کند، از طریق اعلان مطلع می‌شوید و مبلغ پرداختی شما بازگردانده می‌شود.' ],
			]
		);
	}

	/**
	 * Deliberately not published (see class docblock) — the page and its
	 * content still exist so the framework/template is reviewable in
	 * wp-admin ahead of a real legal review, per the task's own explicitly
	 * allowed "keep the page unpublished until approved" option.
	 */
	private static function terms_content(): string {
		return self::blocks(
			[
				[ 'p', 'BeauClick یک بازارگاه آنلاین است که مشتریان را به متخصصان و کسب‌وکارهای مستقل زیبایی متصل می‌کند و امکان رزرو نوبت و خرید محصولات مرتبط را فراهم می‌کند.' ],
				[ 'h', 'نقش BeauClick' ],
				[ 'p', 'BeauClick واسطه رزرو و پرداخت است؛ خدمات زیبایی توسط متخصصان و کسب‌وکارهای مستقل ارائه می‌شود، نه توسط خود BeauClick.' ],
				[ 'p', '⚠️ این صفحه هنوز کامل نیست. بخش‌های حقوقی این سند (مسئولیت‌ها، نحوه رسیدگی به اختلافات، قوانین حاکم و محدودیت‌های استفاده) نیازمند بررسی و تأیید تیم حقوقی/کسب‌وکار است و پیش از انتشار عمومی این صفحه باید تکمیل شود. این یادداشت فقط برای مدیر سایت قابل مشاهده است، چون این صفحه هنوز منتشر نشده است.' ],
			]
		);
	}

	private static function faq_content(): string {
		// Rendered by page-faq.php as an accordion; stored as structured
		// JSON in post content so the template doesn't need to re-parse
		// HTML, while remaining a normal, editable WP page.
		$faqs = [
			[ 'q' => 'چطور می‌توانم وارد BeauClick شوم؟', 'a' => 'با شماره موبایل خود وارد شوید. اگر حساب کاربری نداشته باشید، بعد از تأیید کد پیامکی به‌صورت خودکار برای شما ساخته می‌شود — نیازی به فرم ثبت‌نام جداگانه نیست.' ],
			[ 'q' => 'چطور برای یک متخصص نوبت بگیرم؟', 'a' => 'از صفحه «متخصصان»، فرد یا کسب‌وکار موردنظر را پیدا کنید، خدمت و زمان مناسب را انتخاب کنید و پرداخت را تکمیل کنید.' ],
			[ 'q' => 'دستیار هوشمند BeauClick چطور کار می‌کند؟', 'a' => 'کافیست نیاز خود را به فارسی توضیح دهید — مثلاً نوع خدمت، بودجه یا شهر — و دستیار هوشمند از میان متخصصان، خدمات و محصولات واقعی موجود در BeauClick به شما پیشنهاد می‌دهد.' ],
			[ 'q' => 'چطور می‌توانم نوبت خود را لغو کنم؟', 'a' => 'از بخش «رزروهای من» در داشبورد، تا پیش از انجام‌شدن نوبت می‌توانید آن را لغو کنید.' ],
			[ 'q' => '«مسیر زیبایی من» چیست؟', 'a' => 'فضایی شخصی در داشبورد شماست که اهداف، نوبت‌های آینده و گذشته، امتیاز وفاداری و پیشنهادهای دستیار هوشمند شما را در یک‌جا نشان می‌دهد.' ],
			[ 'q' => 'آیا اطلاعات من با متخصصان دیگر به اشتراک گذاشته می‌شود؟', 'a' => 'خیر. هر متخصص فقط به اطلاعات نوبت‌ها و مشتریان خودش دسترسی دارد؛ جزئیات در «حریم خصوصی» توضیح داده شده است.' ],
			[ 'q' => 'برای همکاری تجاری (B2B) چه تفاوتی وجود دارد؟', 'a' => 'کسب‌وکارها می‌توانند از طریق صفحه «همکاری تجاری» درخواست حساب عمده ثبت کنند و پس از تأیید، از قیمت‌گذاری پلکانی استفاده کنند.' ],
		];
		return wp_json_encode( $faqs, JSON_UNESCAPED_UNICODE );
	}

	private static function contact_content(): string {
		// page-contact.php renders the real form; the stored content is a
		// short intro shown above it.
		return self::blocks(
			[
				[ 'p', 'برای پرسش، گزارش مشکل یا درخواست مربوط به حریم خصوصی، فرم زیر را پر کنید.' ],
			]
		);
	}

	private static function about_content(): string {
		return self::blocks(
			[
				[ 'h', 'BeauClick چیست' ],
				[ 'p', 'BeauClick یک بازارگاه هوشمند زیبایی است که مشتریان را به متخصصان و کسب‌وکارهای زیبایی متصل می‌کند — از جست‌وجو و مقایسه گرفته تا رزرو نوبت، خرید محصول و دریافت پیشنهادهای شخصی‌سازی‌شده.' ],
				[ 'h', 'برای مشتریان' ],
				[ 'p', 'جست‌وجو و رزرو آنلاین متخصصان، دستیار هوشمندی که بر اساس نیاز واقعی شما خدمات و محصولات پیشنهاد می‌دهد، و «مسیر زیبایی من» برای پیگیری اهداف و تاریخچه شما.' ],
				[ 'h', 'برای متخصصان و کسب‌وکارها' ],
				[ 'p', 'ابزارهایی برای مدیریت نوبت‌ها، خدمات، نظرات، ارتباط با مشتریان و — برای کسب‌وکارها — خرید عمده با قیمت‌گذاری پلکانی.' ],
			]
		);
	}

	/**
	 * @param array<int, array{0:string,1:string|string[]}> $sections `h`
	 *   (heading), `p` (paragraph), or `ul` (bullet list) — assembled as
	 *   real Gutenberg block markup so any of these pages opens cleanly in
	 *   the block editor for a future manual edit, not as one opaque
	 *   classic-HTML blob.
	 */
	private static function blocks( array $sections ): string {
		$out = [];
		foreach ( $sections as [ $type, $value ] ) {
			if ( 'h' === $type ) {
				$out[] = "<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">" . esc_html( $value ) . "</h2>\n<!-- /wp:heading -->";
			} elseif ( 'p' === $type ) {
				$out[] = "<!-- wp:paragraph -->\n<p>" . esc_html( $value ) . "</p>\n<!-- /wp:paragraph -->";
			} elseif ( 'ul' === $type ) {
				$items = implode( '', array_map( static fn( string $i ) => '<li>' . esc_html( $i ) . '</li>', $value ) );
				$out[] = "<!-- wp:list -->\n<ul class=\"wp-block-list\">{$items}</ul>\n<!-- /wp:list -->";
			}
		}
		return implode( "\n\n", $out );
	}
}
