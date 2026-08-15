<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Database\Seeds;

/**
 * Demo Shop products (skincare/haircare, matching the design handoff's
 * examples) so the Shop/Product/Cart/Checkout pages have real data to
 * render locally. Idempotent by SKU — checked before every insert, safe
 * to run repeatedly via `wp bc:seed shop`. Lives in beauclick-payments
 * rather than inline in the theme's functions.php: demo/dev data
 * generation is exactly what the project's seeder pattern (Database\Seeds
 * + the `beauclick/seed` action, used identically by every other module)
 * already exists for.
 */
final class DemoProductsSeed {

	/** @return list<array{sku:string, name:string, price:int, oldPrice?:int, category:string, description:string, mockup:string}> */
	private static function products(): array {
		return [
			[
				'sku'         => 'bc-demo-serum-c',
				'name'        => 'سرم ویتامین C',
				'price'       => 480000,
				'oldPrice'    => 600000,
				'category'    => 'مراقبت پوست',
				'description' => 'سرم روشن‌کننده و آنتی‌اکسیدان قوی برای پوست‌های کدر و خسته.',
				'mockup'      => 'product-serum.svg',
			],
			[
				'sku'         => 'bc-demo-moisturizer',
				'name'        => 'مرطوب‌کننده روزانه',
				'price'       => 350000,
				'category'    => 'مراقبت پوست',
				'description' => 'مرطوب‌کننده سبک و غیرچرب مناسب استفاده روزانه زیر آرایش.',
				'mockup'      => 'product-moisturizer.svg',
			],
			[
				'sku'         => 'bc-demo-hair-mask',
				'name'        => 'ماسک ترمیم‌کننده مو',
				'price'       => 420000,
				'category'    => 'مراقبت مو',
				'description' => 'ماسک تقویتی برای موهای آسیب‌دیده و شکننده.',
				'mockup'      => 'product-hairmask.svg',
			],
			[
				'sku'         => 'bc-demo-shampoo',
				'name'        => 'شامپو ضدریزش',
				'price'       => 290000,
				'oldPrice'    => 340000,
				'category'    => 'مراقبت مو',
				'description' => 'شامپو تقویت‌کننده فولیکول مو با عصاره‌های گیاهی.',
				'mockup'      => 'product-shampoo.svg',
			],
			[
				'sku'         => 'bc-demo-sunscreen',
				'name'        => 'ضدآفتاب پوست چرب SPF50',
				'price'       => 380000,
				'category'    => 'مراقبت پوست',
				'description' => 'ضدآفتاب بدون چربی و مات‌کننده، مناسب پوست‌های چرب و مختلط.',
				'mockup'      => 'product-sunscreen.svg',
			],
			[
				'sku'         => 'bc-demo-lipstick',
				'name'        => 'رژ لب مات',
				'price'       => 220000,
				'category'    => 'آرایش',
				'description' => 'رژ لب مات با ماندگاری بالا و بافت سبک.',
				'mockup'      => 'product-lipstick.svg',
			],
		];
	}

	public static function run(): void {
		foreach ( self::products() as $data ) {
			$existing_id = wc_get_product_id_by_sku( $data['sku'] );
			if ( $existing_id ) {
				continue; // Idempotent — already seeded.
			}

			$product = new \WC_Product_Simple();
			$product->set_name( $data['name'] );
			$product->set_sku( $data['sku'] );
			$product->set_description( $data['description'] );
			$product->set_regular_price( (string) ( $data['oldPrice'] ?? $data['price'] ) );
			if ( isset( $data['oldPrice'] ) ) {
				$product->set_sale_price( (string) $data['price'] );
			}
			$product->set_status( 'publish' );
			$product->set_catalog_visibility( 'visible' );
			$product->set_manage_stock( true );
			$product->set_stock_quantity( 50 );
			$product->set_stock_status( 'instock' );
			$product_id = $product->save();

			// Temporary visual mockup only — see DemoProvidersSeed's identical
			// pattern and inc/helpers.php's bc_mockup_image_url() docblock for
			// why this is postmeta, not a real WooCommerce product image
			// (`_thumbnail_id`, which requires a Media Library attachment SVG
			// isn't allowed to become).
			update_post_meta( $product_id, '_bc_mockup_image', $data['mockup'] );

			$category = self::get_or_create_category( $data['category'] );
			if ( $category ) {
				wp_set_object_terms( $product_id, [ $category ], 'product_cat' );
			}
		}
	}

	private static function get_or_create_category( string $name ): ?int {
		$term = term_exists( $name, 'product_cat' );
		if ( $term ) {
			return (int) $term['term_id'];
		}
		$result = wp_insert_term( $name, 'product_cat' );
		return is_wp_error( $result ) ? null : (int) $result['term_id'];
	}
}
