<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Benefits;

use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Loyalty\Tiers\TierService;

/**
 * V2.1 Step 9 — a reusable entitlement model, not benefits-as-strings. Each
 * benefit belongs to either a tier or a membership plan (`source_type`/
 * `source_id`, the same polymorphic-reference shape already used by
 * `wp_bc_events`/`wp_bc_loyalty_points`) and carries a typed `config` (JSON)
 * rather than free text. Only two functional benefit types are wired to
 * real behavior in this step -- `bonus_points_multiplier` (consumed by
 * EarningRules via a filter) and `discount_percentage` (consumed by
 * Pricing\MembershipDiscount on booking orders only, never WooCommerce
 * carts) -- per the task's own "only implement benefit types that are
 * actually needed now" instruction. `descriptive` covers anything else an
 * admin wants to communicate (e.g. "دسترسی زودتر به تخفیف‌های ویژه") with
 * no functional wiring; the model supports adding a new functional type
 * later without a schema change.
 */
final class BenefitService {

	public const SOURCE_TIER             = 'tier';
	public const SOURCE_MEMBERSHIP_PLAN  = 'membership_plan';

	public const TYPE_BONUS_POINTS_MULTIPLIER = 'bonus_points_multiplier';
	public const TYPE_DISCOUNT_PERCENTAGE     = 'discount_percentage';
	public const TYPE_DESCRIPTIVE             = 'descriptive';

	public const TYPES = [ self::TYPE_BONUS_POINTS_MULTIPLIER, self::TYPE_DISCOUNT_PERCENTAGE, self::TYPE_DESCRIPTIVE ];

	/** @return list<array{id:int,sourceType:string,sourceId:int,benefitType:string,label:string,config:array<string,mixed>,isActive:bool,sortOrder:int}> */
	public function for_source( string $source_type, int $source_id, bool $active_only = false ): array {
		global $wpdb;
		$where = $active_only ? 'AND is_active = 1' : '';
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_loyalty_benefits WHERE source_type = %s AND source_id = %d {$where} ORDER BY sort_order ASC", $source_type, $source_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/**
	 * All benefits currently granted to a user -- from their qualifying
	 * TIER and, separately, from their ACTIVE membership plan (a customer
	 * can have both at once; e.g. a tier grants a points multiplier while a
	 * paid membership plan separately grants a discount). Never assumes a
	 * verified/qualified tier implies a membership, or the reverse -- see
	 * this step's own explicit "keep loyalty and membership separate"
	 * instruction.
	 *
	 * @return list<array<string, mixed>>
	 */
	public function benefits_for_user( int $user_id ): array {
		$benefits = [];

		$tier = ( new TierService() )->progress_for_user( $user_id )['currentTier'];
		if ( $tier ) {
			$benefits = array_merge( $benefits, $this->for_source( self::SOURCE_TIER, $tier['id'], true ) );
		}

		$membership = ( new MembershipService() )->for_user( $user_id );
		if ( $membership && 'active' === $membership['status'] ) {
			$benefits = array_merge( $benefits, $this->for_source( self::SOURCE_MEMBERSHIP_PLAN, $membership['planId'], true ) );
		}

		return $benefits;
	}

	/** Highest applicable multiplier, defaulting to 1.0 (no bonus) when none applies -- never less than 1.0, a benefit can only help. */
	public function points_multiplier_for_user( int $user_id ): float {
		$multiplier = 1.0;
		foreach ( $this->benefits_for_user( $user_id ) as $b ) {
			if ( self::TYPE_BONUS_POINTS_MULTIPLIER === $b['benefitType'] ) {
				$multiplier = max( $multiplier, (float) ( $b['config']['multiplier'] ?? 1.0 ) );
			}
		}
		return $multiplier;
	}

	/** Highest applicable percentage (0-100), defaulting to 0.0 when none applies. */
	public function discount_percentage_for_user( int $user_id ): float {
		$percent = 0.0;
		foreach ( $this->benefits_for_user( $user_id ) as $b ) {
			if ( self::TYPE_DISCOUNT_PERCENTAGE === $b['benefitType'] ) {
				$percent = max( $percent, (float) ( $b['config']['percentage'] ?? 0.0 ) );
			}
		}
		return min( 100.0, max( 0.0, $percent ) );
	}

	/** @param array<string, mixed> $config @return array{id:int}|string */
	public function create( string $source_type, int $source_id, string $benefit_type, string $label, array $config, int $sort_order = 0 ) {
		if ( ! in_array( $source_type, [ self::SOURCE_TIER, self::SOURCE_MEMBERSHIP_PLAN ], true ) ) {
			return 'نوع منبع مزیت نامعتبر است.';
		}
		if ( ! in_array( $benefit_type, self::TYPES, true ) ) {
			return 'نوع مزیت نامعتبر است.';
		}
		if ( '' === trim( $label ) ) {
			return 'عنوان مزیت الزامی است.';
		}

		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_loyalty_benefits',
			[
				'source_type'  => $source_type,
				'source_id'    => $source_id,
				'benefit_type' => $benefit_type,
				'label'        => $label,
				'config'       => wp_json_encode( $config ),
				'is_active'    => 1,
				'sort_order'   => $sort_order,
				'created_at'   => current_time( 'mysql' ),
			],
			[ '%s', '%d', '%s', '%s', '%s', '%d', '%d', '%s' ]
		);

		return [ 'id' => (int) $wpdb->insert_id ];
	}

	/** @param array<string, mixed> $fields */
	public function update( int $id, array $fields ) {
		global $wpdb;
		$data   = [];
		$format = [];

		if ( isset( $fields['label'] ) ) {
			$data['label'] = (string) $fields['label'];
			$format[]      = '%s';
		}
		if ( isset( $fields['config'] ) && is_array( $fields['config'] ) ) {
			$data['config'] = wp_json_encode( $fields['config'] );
			$format[]       = '%s';
		}
		if ( isset( $fields['isActive'] ) ) {
			$data['is_active'] = ! empty( $fields['isActive'] ) ? 1 : 0;
			$format[]          = '%d';
		}

		if ( $data ) {
			$wpdb->update( $wpdb->prefix . 'bc_loyalty_benefits', $data, [ 'id' => $id ], $format, [ '%d' ] );
		}
	}

	public function delete( int $id ): void {
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'bc_loyalty_benefits', [ 'id' => $id ], [ '%d' ] );
	}

	private function format( array $row ): array {
		return [
			'id'          => (int) $row['id'],
			'sourceType'  => $row['source_type'],
			'sourceId'    => (int) $row['source_id'],
			'benefitType' => $row['benefit_type'],
			'label'       => $row['label'],
			'config'      => $row['config'] ? (array) json_decode( (string) $row['config'], true ) : [],
			'isActive'    => (bool) $row['is_active'],
			'sortOrder'   => (int) $row['sort_order'],
		];
	}
}
