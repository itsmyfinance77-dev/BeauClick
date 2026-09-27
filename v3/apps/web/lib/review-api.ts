/**
 * DEMO BRANCH ONLY (demo remediation: missing web paths) — the review routes
 * that already existed in the API with no screen:
 *
 *  - `POST /v1/bookings/:id/review` `{ rating 1..5, comment? ≤2000 }` — the
 *    customer reviews their own completed booking (eligibility is the server's);
 *  - `GET  /v1/me/reviews` — the caller's own reviews, so a booking already
 *    reviewed shows the review instead of a form that would 409;
 *  - `GET  /v1/providers/:id/reviews` — a professional's public reviews;
 *  - `POST /v1/providers/:id/reviews/:reviewId/respond` `{ text 1..2000 }` —
 *    the professional's own reply (ownership is the server's).
 */
import type { ApiClient } from './api-client';

export interface PublicReview {
  id: string;
  rating: number;
  comment: string | null;
  response: { text: string; respondedAt: string | null } | null;
  createdAt: string;
}

export interface MyReview extends PublicReview {
  bookingId: string;
  professionalId: string;
  status: 'published' | 'hidden';
}

export const reviewApi = {
  create: (api: ApiClient, bookingId: string, body: { rating: number; comment?: string }) =>
    api.post<PublicReview>(`/v1/bookings/${encodeURIComponent(bookingId)}/review`, body),

  mine: (api: ApiClient) => api.get<MyReview[]>('/v1/me/reviews?page=1&limit=100'),

  forProfessional: (api: ApiClient, professionalId: string) =>
    api.get<PublicReview[]>(`/v1/providers/${encodeURIComponent(professionalId)}/reviews?page=1&limit=100`),

  respond: (api: ApiClient, professionalId: string, reviewId: string, text: string) =>
    api.post<PublicReview>(
      `/v1/providers/${encodeURIComponent(professionalId)}/reviews/${encodeURIComponent(reviewId)}/respond`,
      { text },
    ),
};
