<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Seeds;

use BeauClick\Core\Roles\RoleManager;
use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * Local-dev / demo reference data — realistic Yazd-first professionals so
 * the marketplace/home pages have something real to render against instead
 * of empty states. Never runs against production content unintentionally:
 * only fires via `wp bc:seed` / `wp bc:seed marketplace`, and is idempotent
 * (checked by user_login before creating anything).
 */
final class DemoProvidersSeed {

	private static function city_id( string $slug ): ?int {
		global $wpdb;
		$id = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_cities WHERE slug = %s", $slug ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $id ? (int) $id : null;
	}

	private static function district_id( int $city_id, string $slug ): ?int {
		global $wpdb;
		$id = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_districts WHERE city_id = %d AND slug = %s", $city_id, $slug ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $id ? (int) $id : null;
	}

	private static function specialty_term( string $name, string $slug ): int {
		$term = term_exists( $slug, Registrar::SPECIALTY );
		if ( $term ) {
			return (int) $term['term_id'];
		}
		$result = wp_insert_term( $name, Registrar::SPECIALTY, [ 'slug' => $slug ] );
		return (int) $result['term_id'];
	}

	/** @return array<int, array{login: string, name: string, bio: string, specialty: array{name:string,slug:string}, city: string, district?: string, verified: bool, mockup: string, mockupCover: string, services: list<array{name:string,duration:int,price:int}>}> */
	private static function providers(): array {
		return [
			[
				'login'     => 'bc_demo_sara_ahmadi',
				'name'      => 'سارا احمدی',
				'bio'       => 'میکاپ‌آرتیست حرفه‌ای با بیش از ۸ سال سابقه در میکاپ عروس و مراسم، فارغ‌التحصیل آکادمی زیبایی یزد.',
				'specialty' => [ 'name' => 'میکاپ', 'slug' => 'makeup' ],
				'city'      => 'yazd',
				'district'  => 'safaeieh',
				'verified'  => true,
				'mockup'    => 'professional-1.svg',
				'mockupCover' => 'salon-1.svg',
				'services'  => [
					[ 'name' => 'میکاپ عروس', 'duration' => 120, 'price' => 2500000 ],
					[ 'name' => 'میکاپ مراسم', 'duration' => 60, 'price' => 850000 ],
				],
			],
			[
				'login'     => 'bc_demo_niloofar_kermani',
				'name'      => 'نیلوفر کرمانی',
				'bio'       => 'متخصص ناخن و کاشت، ارائه‌دهنده جدیدترین تکنیک‌های طراحی ناخن در یزد.',
				'specialty' => [ 'name' => 'ناخن', 'slug' => 'nails' ],
				'city'      => 'yazd',
				'district'  => 'fahadan',
				'verified'  => true,
				'mockup'    => 'professional-2.svg',
				'mockupCover' => 'salon-2.svg',
				'services'  => [
					[ 'name' => 'کاشت ناخن ژل', 'duration' => 90, 'price' => 650000 ],
					[ 'name' => 'طراحی ناخن', 'duration' => 45, 'price' => 350000 ],
				],
			],
			[
				'login'     => 'bc_demo_mahsa_rezaei',
				'name'      => 'مهسا رضایی',
				'bio'       => 'متخصص پوست و مو، مشاوره تخصصی مراقبت پوست چرب و خشک.',
				'specialty' => [ 'name' => 'پوست و مو', 'slug' => 'skin-hair' ],
				'city'      => 'yazd',
				'district'  => 'shahedieh',
				'verified'  => false,
				'mockup'    => 'professional-3.svg',
				'mockupCover' => 'salon-3.svg',
				'services'  => [
					[ 'name' => 'پاکسازی پوست', 'duration' => 60, 'price' => 550000 ],
				],
			],
			[
				'login'     => 'bc_demo_parisa_hosseini',
				'name'      => 'پریسا حسینی',
				'bio'       => 'رنگ‌کار و کوتاه‌کار حرفه‌ای، متخصص رنگ‌های فانتزی و بالیاژ.',
				'specialty' => [ 'name' => 'رنگ مو', 'slug' => 'hair-color' ],
				'city'      => 'isfahan',
				'verified'  => true,
				'mockup'    => 'professional-4.svg',
				'mockupCover' => 'salon-1.svg',
				'services'  => [
					[ 'name' => 'رنگ و بالیاژ', 'duration' => 150, 'price' => 1800000 ],
					[ 'name' => 'کوتاهی تخصصی', 'duration' => 45, 'price' => 400000 ],
				],
			],
			[
				'login'     => 'bc_demo_atefeh_karimi',
				'name'      => 'عاطفه کریمی',
				'bio'       => 'میکاپ‌آرتیست و متخصص ابرو، فعال در تهران با بیش از ۵ سال سابقه.',
				'specialty' => [ 'name' => 'میکاپ', 'slug' => 'makeup' ],
				'city'      => 'tehran',
				'verified'  => true,
				'mockup'    => 'professional-5.svg',
				'mockupCover' => 'salon-2.svg',
				'services'  => [
					[ 'name' => 'میکاپ روزانه', 'duration' => 45, 'price' => 600000 ],
					[ 'name' => 'میکاپ عروس', 'duration' => 120, 'price' => 3200000 ],
				],
			],
		];
	}

	public static function run(): void {
		foreach ( self::providers() as $data ) {
			$user = get_user_by( 'login', $data['login'] );
			if ( ! $user ) {
				$user_id = wp_insert_user(
					[
						'user_login' => $data['login'],
						'user_pass'  => wp_generate_password( 24 ),
						'user_email' => $data['login'] . '@demo.beauclick.test',
						'role'       => RoleManager::ROLE_PROFESSIONAL,
						'first_name' => $data['name'],
					]
				);
				if ( is_wp_error( $user_id ) ) {
					continue;
				}
			} else {
				$user_id = $user->ID;
			}

			$existing = get_posts(
				[
					'post_type'      => Registrar::PROFESSIONAL,
					'author'         => $user_id,
					'post_status'    => 'any',
					'posts_per_page' => 1,
				]
			);

			if ( $existing ) {
				continue; // Already seeded — idempotent.
			}

			$post_id = wp_insert_post(
				[
					'post_type'    => Registrar::PROFESSIONAL,
					'post_title'   => $data['name'],
					'post_content' => $data['bio'],
					'post_status'  => 'publish',
					'post_author'  => $user_id,
				]
			);

			if ( is_wp_error( $post_id ) || ! $post_id ) {
				continue;
			}

			$city_id = self::city_id( $data['city'] );
			if ( $city_id ) {
				update_post_meta( $post_id, '_bc_city_id', $city_id );
				if ( ! empty( $data['district'] ) ) {
					$district_id = self::district_id( $city_id, $data['district'] );
					if ( $district_id ) {
						update_post_meta( $post_id, '_bc_district_id', $district_id );
					}
				}
			}

			update_post_meta( $post_id, '_bc_verification_status', $data['verified'] ? 'verified' : 'pending' );

			// Temporary visual mockup only — a bare filename under the theme's
			// assets/mockups/, resolved by bc_mockup_image_url() (see
			// inc/helpers.php's own docblock for why this is postmeta, not a
			// real Media Library attachment). Never set on a post this seeder
			// didn't itself just create, and always superseded automatically
			// the moment a real featured image is ever set on this post.
			update_post_meta( $post_id, '_bc_mockup_image', $data['mockup'] );
			update_post_meta( $post_id, '_bc_mockup_cover', $data['mockupCover'] );

			$term_id = self::specialty_term( $data['specialty']['name'], $data['specialty']['slug'] );
			wp_set_post_terms( $post_id, [ $term_id ], Registrar::SPECIALTY );

			foreach ( $data['services'] as $service ) {
				$service_id = wp_insert_post(
					[
						'post_type'   => Registrar::SERVICE,
						'post_title'  => $service['name'],
						'post_status' => 'publish',
						'post_author' => $user_id,
						'post_parent' => $post_id,
					]
				);
				if ( $service_id && ! is_wp_error( $service_id ) ) {
					update_post_meta( $service_id, '_bc_duration_minutes', $service['duration'] );
					update_post_meta( $service_id, '_bc_price', $service['price'] );
					wp_set_post_terms( $service_id, [ $term_id ], Registrar::SPECIALTY );
				}
			}

			// Services are inserted after the profile publishes, so trigger a
			// resync now rather than waiting for the next unrelated save —
			// price_from depends on services that didn't exist yet at publish time.
			( new \BeauClick\Marketplace\Search\Indexer() )->sync( $post_id, Registrar::PROFESSIONAL );
		}
	}
}
