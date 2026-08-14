<?php
declare( strict_types=1 );

namespace BeauClick\Core\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Support\JalaliDate;

/**
 * V2.2 Step 13 — a small, read-only operator view wrapping WordPress's own
 * user data (§15's own instruction: "do not build a second WordPress user
 * management engine"). Deliberately does not add editing, role changes, or
 * password resets — those already exist in native wp-admin Users for
 * anyone who also holds `list_users`/`edit_users`; this page exists so a
 * BeauClick platform operator (who may hold only `bc_manage_platform`, not
 * full user-management capabilities — see RoleManager::ROLE_PLATFORM_OPERATOR)
 * can still look up a BeauClick account by name/email/phone without being
 * granted broader WordPress user-management authority than their job needs.
 *
 * Phone numbers are always shown partially masked — this page shows more
 * users at once than a professional's own CRM ever would, so the same
 * minimization discipline applies.
 */
final class UsersAdminPage {

	private const SLUG     = 'beauclick-users';
	private const PER_PAGE = 20;

	private const ROLE_LABELS = [
		'administrator'       => 'مدیر سیستم',
		'bc_platform_operator' => 'متصدی عملیات پلتفرم',
		'bc_moderator'         => 'ناظر بیوکلیک',
		'bc_support'           => 'پشتیبانی بیوکلیک',
		'bc_business'          => 'کسب‌وکار',
		'bc_professional'      => 'متخصص',
		'customer'             => 'مشتری',
		'subscriber'           => 'مشترک',
	];

	/** Priority 8 — see OperationsHealthPage::register()'s docblock for why hook priority, not add_submenu_page()'s own $position argument, is what actually controls this menu's ordering. */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 8 );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'کاربران', 'beauclick-core' ),
			__( 'کاربران', 'beauclick-core' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-core' ), 403 );
		}

		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only GET search/filter, no state mutation.
		$search = isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['s'] ) ) : '';
		$role   = isset( $_GET['role'] ) ? sanitize_key( wp_unslash( (string) $_GET['role'] ) ) : '';
		$page   = max( 1, isset( $_GET['paged'] ) ? (int) $_GET['paged'] : 1 );
		// phpcs:enable

		AdminShell::header(
			__( 'کاربران', 'beauclick-core' ),
			__( 'جست‌وجوی حساب‌های ثبت‌شده — یک نمای عملیاتی سبک روی داده‌های موجود وردپرس، بدون امکان ویرایش نقش یا رمز عبور.', 'beauclick-core' ),
			[ [ 'label' => __( 'کاربران', 'beauclick-core' ) ] ]
		);

		$this->render_filters( $search, $role );

		[ $users, $total ] = $this->query_users( $search, $role, $page );

		if ( ! $users ) {
			AdminShell::empty_state( __( 'کاربری با این مشخصات پیدا نشد.', 'beauclick-core' ) );
		} else {
			AdminShell::table_open();
			echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
			echo '<th>' . esc_html__( 'نام', 'beauclick-core' ) . '</th>';
			echo '<th>' . esc_html__( 'ایمیل', 'beauclick-core' ) . '</th>';
			echo '<th>' . esc_html__( 'تلفن', 'beauclick-core' ) . '</th>';
			echo '<th>' . esc_html__( 'نقش', 'beauclick-core' ) . '</th>';
			echo '<th>' . esc_html__( 'تاریخ عضویت', 'beauclick-core' ) . '</th>';
			echo '</tr></thead><tbody>';

			foreach ( $users as $user ) {
				$roles = array_map( static fn ( string $r ) => self::ROLE_LABELS[ $r ] ?? $r, $user->roles );
				echo '<tr>';
				echo '<td>' . esc_html( $user->display_name ) . '</td>';
				echo '<td>' . esc_html( $user->user_email ) . '</td>';
				echo '<td class="bc-numeric">' . esc_html( $this->masked_phone( (string) get_user_meta( $user->ID, '_billing_phone', true ) ) ) . '</td>';
				echo '<td>' . esc_html( implode( '، ', $roles ) ?: '—' ) . '</td>';
				echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $user->user_registered ) ) . '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
			AdminShell::table_close();

			$this->render_pagination( $page, $total, $search, $role );
		}

		AdminShell::footer();
	}

	private function render_filters( string $search, string $role ): void {
		echo '<form method="get" class="bc-admin-filters">';
		echo '<input type="hidden" name="page" value="' . esc_attr( self::SLUG ) . '" />';
		echo '<label class="screen-reader-text" for="bc-users-search">' . esc_html__( 'جست‌وجو', 'beauclick-core' ) . '</label>';
		echo '<input type="search" id="bc-users-search" name="s" value="' . esc_attr( $search ) . '" placeholder="' . esc_attr__( 'نام، ایمیل یا تلفن…', 'beauclick-core' ) . '" />';
		echo '<select name="role"><option value="">' . esc_html__( 'همهٔ نقش‌ها', 'beauclick-core' ) . '</option>';
		foreach ( self::ROLE_LABELS as $slug => $label ) {
			echo '<option value="' . esc_attr( $slug ) . '"' . selected( $role, $slug, false ) . '>' . esc_html( $label ) . '</option>';
		}
		echo '</select>';
		echo '<button type="submit" class="button">' . esc_html__( 'جست‌وجو', 'beauclick-core' ) . '</button>';
		echo '</form>';
	}

	private function render_pagination( int $page, int $total, string $search, string $role ): void {
		$pages = (int) ceil( $total / self::PER_PAGE );
		if ( $pages <= 1 ) {
			return;
		}
		echo '<p class="bc-admin-pagination">';
		for ( $i = 1; $i <= $pages; $i++ ) {
			$url = add_query_arg(
				array_filter( [ 'page' => self::SLUG, 'paged' => $i, 's' => $search, 'role' => $role ] ),
				admin_url( 'admin.php' )
			);
			$css = 'button' . ( $i === $page ? ' button-primary' : '' );
			echo '<a class="' . esc_attr( $css ) . '" style="margin-inline-end:4px;" href="' . esc_url( $url ) . '">' . esc_html( JalaliDate::persianDigits( (string) $i ) ) . '</a>';
		}
		echo '</p>';
	}

	/**
	 * @return array{0: \WP_User[], 1: int}
	 */
	private function query_users( string $search, string $role, int $page ): array {
		if ( '' === $search ) {
			$args = [
				'number'      => self::PER_PAGE,
				'offset'      => ( $page - 1 ) * self::PER_PAGE,
				'orderby'     => 'registered',
				'order'       => 'DESC',
				'count_total' => true,
			];
			if ( '' !== $role ) {
				$args['role'] = $role;
			}
			$query = new \WP_User_Query( $args );
			return [ $query->get_results(), (int) $query->get_total() ];
		}

		// WP_User_Query's own 'search' (core columns: login/email/display
		// name) and 'meta_query' (usermeta, e.g. phone) are ANDed together
		// by the query builder — there is no built-in way to ask for
		// "core-column match OR phone match" in one query. Two bounded
		// queries, merged/deduped/sorted/paginated here in PHP, is the
		// correct trade-off for an internal lookup tool at this data
		// volume — never an unbounded scan (each half is capped).
		$common_role_arg = '' !== $role ? [ 'role' => $role ] : [];

		$by_core = ( new \WP_User_Query(
			array_merge(
				$common_role_arg,
				[
					'search'         => '*' . $search . '*',
					'search_columns' => [ 'user_login', 'user_email', 'display_name' ],
					'number'         => 200,
					'orderby'        => 'registered',
					'order'          => 'DESC',
				]
			)
		) )->get_results();

		$by_phone = ( new \WP_User_Query(
			array_merge(
				$common_role_arg,
				[
					'meta_query' => [ [ 'key' => '_billing_phone', 'value' => $search, 'compare' => 'LIKE' ] ], // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					'number'     => 200,
					'orderby'    => 'registered',
					'order'      => 'DESC',
				]
			)
		) )->get_results();

		$merged = [];
		foreach ( array_merge( $by_core, $by_phone ) as $user ) {
			$merged[ $user->ID ] = $user;
		}
		usort( $merged, static fn ( \WP_User $a, \WP_User $b ) => strcmp( $b->user_registered, $a->user_registered ) );

		$total = count( $merged );
		$slice = array_slice( $merged, ( $page - 1 ) * self::PER_PAGE, self::PER_PAGE );

		return [ $slice, $total ];
	}

	private function masked_phone( string $raw ): string {
		if ( '' === $raw ) {
			return '—';
		}
		$digits = preg_replace( '/\D/', '', $raw ) ?? '';
		if ( strlen( $digits ) < 7 ) {
			return JalaliDate::persianDigits( $raw );
		}
		$masked = substr( $digits, 0, 4 ) . '***' . substr( $digits, -4 );
		return JalaliDate::persianDigits( $masked );
	}
}
