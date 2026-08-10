<?php
declare( strict_types=1 );

namespace BeauClick\Locations\Database\Seeds;

/**
 * Reference data for all 31 Iranian provinces, seeded so the location model
 * is nationwide from day one (architecture doc: "never hard-code Tehran,
 * Yazd is the initial launch city, not a limit"). Every province gets its
 * capital city at minimum; a handful of higher-traffic provinces get a few
 * more cities to start; districts are seeded only for Yazd (the launch
 * city) since that's the only place neighborhood-level granularity matters
 * yet — more districts get added by ops as coverage grows, same as the
 * design handoff's note about extending the city-filter chip list.
 *
 * `is_launched` is true only for یزد / تهران / اصفهان, matching the design
 * handoff's example marketplace filter chips exactly — everything else
 * exists as real reference data but doesn't yet surface as a filter option.
 */
final class IranLocationsSeed {

	/** @return array<string, array{name: string, cities: list<array{name: string, slug: string, launched?: bool, districts?: list<array{name: string, slug: string}>}>}> */
	public static function data(): array {
		return [
			'east-azerbaijan'        => [
				'name'   => 'آذربایجان شرقی',
				'cities' => [ [ 'name' => 'تبریز', 'slug' => 'tabriz' ] ],
			],
			'west-azerbaijan'        => [
				'name'   => 'آذربایجان غربی',
				'cities' => [ [ 'name' => 'ارومیه', 'slug' => 'urmia' ] ],
			],
			'ardabil'                => [
				'name'   => 'اردبیل',
				'cities' => [ [ 'name' => 'اردبیل', 'slug' => 'ardabil' ] ],
			],
			'isfahan'                => [
				'name'   => 'اصفهان',
				'cities' => [
					[ 'name' => 'اصفهان', 'slug' => 'isfahan', 'launched' => true ],
					[ 'name' => 'کاشان', 'slug' => 'kashan' ],
					[ 'name' => 'نجف‌آباد', 'slug' => 'najafabad' ],
				],
			],
			'alborz'                 => [
				'name'   => 'البرز',
				'cities' => [ [ 'name' => 'کرج', 'slug' => 'karaj' ] ],
			],
			'ilam'                   => [
				'name'   => 'ایلام',
				'cities' => [ [ 'name' => 'ایلام', 'slug' => 'ilam' ] ],
			],
			'bushehr'                => [
				'name'   => 'بوشهر',
				'cities' => [ [ 'name' => 'بوشهر', 'slug' => 'bushehr' ] ],
			],
			'tehran'                 => [
				'name'   => 'تهران',
				'cities' => [
					[ 'name' => 'تهران', 'slug' => 'tehran', 'launched' => true ],
					[ 'name' => 'شهریار', 'slug' => 'shahriar' ],
					[ 'name' => 'اسلامشهر', 'slug' => 'eslamshahr' ],
				],
			],
			'chaharmahal-bakhtiari'  => [
				'name'   => 'چهارمحال و بختیاری',
				'cities' => [ [ 'name' => 'شهرکرد', 'slug' => 'shahrekord' ] ],
			],
			'south-khorasan'         => [
				'name'   => 'خراسان جنوبی',
				'cities' => [ [ 'name' => 'بیرجند', 'slug' => 'birjand' ] ],
			],
			'razavi-khorasan'        => [
				'name'   => 'خراسان رضوی',
				'cities' => [
					[ 'name' => 'مشهد', 'slug' => 'mashhad' ],
					[ 'name' => 'نیشابور', 'slug' => 'neyshabur' ],
				],
			],
			'north-khorasan'         => [
				'name'   => 'خراسان شمالی',
				'cities' => [ [ 'name' => 'بجنورد', 'slug' => 'bojnord' ] ],
			],
			'khuzestan'              => [
				'name'   => 'خوزستان',
				'cities' => [ [ 'name' => 'اهواز', 'slug' => 'ahvaz' ] ],
			],
			'zanjan'                 => [
				'name'   => 'زنجان',
				'cities' => [ [ 'name' => 'زنجان', 'slug' => 'zanjan' ] ],
			],
			'semnan'                 => [
				'name'   => 'سمنان',
				'cities' => [ [ 'name' => 'سمنان', 'slug' => 'semnan' ] ],
			],
			'sistan-baluchestan'     => [
				'name'   => 'سیستان و بلوچستان',
				'cities' => [ [ 'name' => 'زاهدان', 'slug' => 'zahedan' ] ],
			],
			'fars'                   => [
				'name'   => 'فارس',
				'cities' => [
					[ 'name' => 'شیراز', 'slug' => 'shiraz' ],
					[ 'name' => 'مرودشت', 'slug' => 'marvdasht' ],
				],
			],
			'qazvin'                 => [
				'name'   => 'قزوین',
				'cities' => [ [ 'name' => 'قزوین', 'slug' => 'qazvin' ] ],
			],
			'qom'                    => [
				'name'   => 'قم',
				'cities' => [ [ 'name' => 'قم', 'slug' => 'qom' ] ],
			],
			'kurdistan'              => [
				'name'   => 'کردستان',
				'cities' => [ [ 'name' => 'سنندج', 'slug' => 'sanandaj' ] ],
			],
			'kerman'                 => [
				'name'   => 'کرمان',
				'cities' => [ [ 'name' => 'کرمان', 'slug' => 'kerman' ] ],
			],
			'kermanshah'             => [
				'name'   => 'کرمانشاه',
				'cities' => [ [ 'name' => 'کرمانشاه', 'slug' => 'kermanshah' ] ],
			],
			'kohgiluyeh-boyerahmad'  => [
				'name'   => 'کهگیلویه و بویراحمد',
				'cities' => [ [ 'name' => 'یاسوج', 'slug' => 'yasuj' ] ],
			],
			'golestan'               => [
				'name'   => 'گلستان',
				'cities' => [ [ 'name' => 'گرگان', 'slug' => 'gorgan' ] ],
			],
			'gilan'                  => [
				'name'   => 'گیلان',
				'cities' => [ [ 'name' => 'رشت', 'slug' => 'rasht' ] ],
			],
			'lorestan'               => [
				'name'   => 'لرستان',
				'cities' => [ [ 'name' => 'خرم‌آباد', 'slug' => 'khorramabad' ] ],
			],
			'mazandaran'             => [
				'name'   => 'مازندران',
				'cities' => [ [ 'name' => 'ساری', 'slug' => 'sari' ] ],
			],
			'markazi'                => [
				'name'   => 'مرکزی',
				'cities' => [ [ 'name' => 'اراک', 'slug' => 'arak' ] ],
			],
			'hormozgan'              => [
				'name'   => 'هرمزگان',
				'cities' => [ [ 'name' => 'بندرعباس', 'slug' => 'bandar-abbas' ] ],
			],
			'hamadan'                => [
				'name'   => 'همدان',
				'cities' => [ [ 'name' => 'همدان', 'slug' => 'hamadan' ] ],
			],
			'yazd'                   => [
				'name'   => 'یزد',
				'cities' => [
					[
						'name'      => 'یزد',
						'slug'      => 'yazd',
						'launched'  => true,
						'districts' => [
							[ 'name' => 'صفائیه', 'slug' => 'safaeieh' ],
							[ 'name' => 'فهادان', 'slug' => 'fahadan' ],
							[ 'name' => 'شاهدیه', 'slug' => 'shahedieh' ],
							[ 'name' => 'مهرآباد', 'slug' => 'mehrabad' ],
						],
					],
					[ 'name' => 'میبد', 'slug' => 'meybod' ],
					[ 'name' => 'اردکان', 'slug' => 'ardakan' ],
				],
			],
		];
	}

	public static function run(): void {
		global $wpdb;
		$provinces = $wpdb->prefix . 'bc_provinces';
		$cities    = $wpdb->prefix . 'bc_cities';
		$districts = $wpdb->prefix . 'bc_districts';

		foreach ( self::data() as $province_slug => $province ) {
			$province_id = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$provinces} WHERE slug = %s", $province_slug ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

			if ( ! $province_id ) {
				$wpdb->insert( $provinces, [ 'name_fa' => $province['name'], 'slug' => $province_slug ] );
				$province_id = $wpdb->insert_id;
			}

			foreach ( $province['cities'] as $city ) {
				$city_id = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$cities} WHERE slug = %s", $city['slug'] ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

				if ( ! $city_id ) {
					$wpdb->insert(
						$cities,
						[
							'province_id' => $province_id,
							'name_fa'     => $city['name'],
							'slug'        => $city['slug'],
							'is_launched' => ! empty( $city['launched'] ) ? 1 : 0,
						]
					);
					$city_id = $wpdb->insert_id;
				}

				foreach ( $city['districts'] ?? [] as $district ) {
					$exists = $wpdb->get_var(
						$wpdb->prepare( "SELECT id FROM {$districts} WHERE city_id = %d AND slug = %s", $city_id, $district['slug'] ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					);
					if ( ! $exists ) {
						$wpdb->insert(
							$districts,
							[
								'city_id' => $city_id,
								'name_fa' => $district['name'],
								'slug'    => $district['slug'],
							]
						);
					}
				}
			}
		}
	}
}
