/**
 * V2.2 Step 11 — a strictly allow-listed UI-visibility ping. The server
 * (AnalyticsController::track()) independently enforces the same allowlist
 * and always attributes the event to the current logged-in user, never a
 * client-supplied id — this file's own TRACKABLE_EVENTS union type is a
 * dev-time guard, not the real security boundary.
 *
 * Fire-and-forget by design: analytics must never affect the product
 * experience, so a failed/slow /analytics/track call is silently
 * swallowed rather than surfaced to the user or awaited by a caller.
 */

import { api } from './api';

export type TrackableEvent = 'ai_assistant_opened' | 'crm_opened' | 'journey_opened' | 'referral_link_shared';

export function track( event: TrackableEvent ): void {
	if ( ! window.BeauClick?.isLoggedIn ) return;
	void api.post( '/analytics/track', { event } ).catch( () => {} );
}
