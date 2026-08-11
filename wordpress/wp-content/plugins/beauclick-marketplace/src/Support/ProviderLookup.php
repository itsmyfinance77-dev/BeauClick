<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Support;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * The one place that resolves "which bc_professional/bc_business post does
 * this WP user own" — a user's own id and their provider CPT's post id are
 * different numbers (architecture doc §9: "1:1 with a bc_professional CPT
 * they own", not "is"). Every booking/availability/review row is keyed by
 * the CPT post id (the only id server-rendered public pages have to send —
 * see DemoAvailabilitySeed, the original authoritative convention), so any
 * code starting from "the current logged-in professional" must resolve
 * through here first rather than comparing get_current_user_id() directly
 * against a stored provider_id.
 */
final class ProviderLookup {

	public static function for_user( int $user_id ): ?int {
		$posts = get_posts(
			[
				'post_type'      => [ Registrar::PROFESSIONAL, Registrar::BUSINESS ],
				'author'         => $user_id,
				'post_status'    => 'any',
				'posts_per_page' => 1,
				'fields'         => 'ids',
			]
		);
		return $posts[0] ?? null;
	}
}
