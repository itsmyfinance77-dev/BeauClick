# V3.1 Phase D — Claude Design Handoff (reviews and ratings)

**Baseline:** `master` after V3.1 Phase D's backend landed. `v3.1.0` and every earlier tag
untouched. **No release tag was created for this work.**
**Status:** an ADDENDUM to `V3.1.0_CLAUDE_DESIGN_HANDOFF.md` and `PHASE_C_CLAUDE_DESIGN_HANDOFF.md`.
Everything here is backend that exists and has **no UI at all**.

Same vocabulary as the earlier handoffs — **IMPLEMENTABLE**, **BACKEND GAP**,
**PRODUCT DECISION REQUIRED**, **UI REQUIRED**.

---

## 1. What became possible

The marketplace's ranking formula has always had a rating term. Until this phase it received
0/0 for every provider on the platform, so four things that were fully built were also
entirely inert: the Bayesian rating score, the `high_rating` badge, the `minRating` filter,
and the `rating` sort.

They now carry real data. A customer can review a completed booking, a professional can
reply, a moderator can take a review down, and the ranking moves.

None of it is reachable by a human. There is no review form, no rating displayed anywhere,
no star, no moderation screen.

---

## 2. Leaving a review

`POST /v1/bookings/:id/review` — addressed by **booking**, not by professional.

```jsonc
// request
{ "rating": 5, "comment": "..." }   // rating 1-5 required; comment optional, ≤ 2000 chars

// 201
{ "id": "...", "rating": 5, "comment": "...", "response": null, "createdAt": "..." }
```

### The rules a UI has to respect

- **One review per completed booking, ever.** No editing after submission. This is a firm
  product rule, not a missing route — a review is a record of one visit. The reply is
  editable (it is the professional's own words); the review is not.
- **A booking must have completed.** Not confirmed, not paid — completed, meaning the
  professional marked the service delivered.
- **Rating is required; the comment is not.** A star-only review is a first-class outcome and
  should not feel like an incomplete form.

### Errors, already Persian and safe to display

| Situation | HTTP | `error.code` |
|---|---|---|
| booking not completed, not yours, or does not exist | 409 | `REVIEW_NOT_ELIGIBLE` |
| already reviewed this booking | 409 | `CONFLICT` |
| rating outside 1–5 | 400 | `VALIDATION_ERROR` |

The first row is **one message for three situations by design** — distinguishing them would
let anyone probe other people's booking ids and their states. Do not try to render a more
specific reason; there is not one.

### Knowing what is reviewable — **read this before designing the entry point**

There is no "is this reviewable" flag on the booking list, and adding one would mean a
cross-domain read the architecture forbids. The available shape is:

`GET /v1/me/reviews` → the caller's own reviews, each carrying `bookingId`.

So a client joins that against its own booking list: a **completed** booking whose id is not
in the reviews list is reviewable. That is the intended pattern, and it is one extra request
per screen, not per booking.

---

## 3. Displaying reviews

`GET /v1/providers/:id/reviews` — **public**, paginated (`page`, `limit`, max 100).

```jsonc
{
  "id": "...",
  "rating": 4,
  "comment": "..." | null,
  "response": { "text": "...", "respondedAt": "..." } | null,
  "createdAt": "..."
}
```

**There is no reviewer identity in this response, and that is deliberate.** No name, no id,
no avatar. Publishing it would let anyone assemble one customer's entire visit history across
every professional they have booked, from public data. Reviews read as attributed to a visit,
not to a browsable person. If the design wants *something* human there, the honest options
are a relative date and the service booked — not an identity. **PRODUCT DECISION REQUIRED**
if a display name is wanted; it would need a real privacy decision first.

### The aggregate lives on the professional, not on the list

Every professional shape now carries, always present:

```jsonc
"rating": { "average": 4.5, "count": 12 }     // average is null when count is 0
```

Present on `GET /v1/providers`, `GET /v1/providers/:id`, `GET /v1/me/provider`, and
`PATCH /v1/providers/:id` — beside `images`. A profile header therefore needs no second
request, and a search result card already has what it needs.

`average` is rounded to one decimal. `count` counts **published** reviews only, so a takedown
lowers it immediately.

### States

- **Empty** — no reviews. This is the majority state at launch and for every new
  professional, on both the profile and the result card. `{ average: null, count: 0 }` must
  render as something other than "0 stars", which reads as a bad rating rather than no data.
- **Loading / error** — standard; nothing review-specific.
- **Hidden** — a moderated review simply disappears from the list and the count. There is no
  tombstone and no "removed by moderator" placeholder.

---

## 4. The professional's reply

`POST /v1/providers/:id/reviews/:reviewId/respond` — `{ "text": "..." }`, 1–2000 chars.

- Only on **their own** professional profile's reviews. Anything else is a 404.
- **Editable**: posting again replaces the reply. There is no delete-reply route — posting
  again is the only edit. **BACKEND GAP** if the design needs removal.
- Appears publicly nested under the review it answers.

A reply to a bad review is the highest-stakes writing a professional does on this platform.
Worth designing the composition surface with that in mind rather than as a generic text box.

---

## 5. Moderation

**Post-moderation.** A review is public and counted the moment it is written; a moderator's
job is takedown, not gatekeeping.

| Route | Capability |
|---|---|
| `GET /v1/admin/reviews/queue` | `bc_moderate_reviews` |
| `POST /v1/admin/reviews/:id/moderate` | `bc_moderate_reviews` |

The queue is **untriaged** reviews — oldest first — and it drains on any decision:

```jsonc
{ "decision": "hide" | "publish", "reason": "..." }   // reason required both ways, 4-500 chars
```

- `hide` removes it from the public list, lowers the count, and **takes its rating back out
  of the ranking**.
- `publish` on an untriaged review changes nothing publicly and records "a moderator looked
  at this and it is fine". Without it the only way to clear the queue would be to hide things
  — the UI should make that a first-class action, not a secondary one.
- `publish` on a hidden review **restores** it, rating and all. Moderation is reversible.
- Deciding twice the same way is a 409: the review was already triaged.

The queue **does** include each review's comment text — reading it is the job. Everywhere
else, that text stays out of events, logs, and audit snapshots.

### Who sees this section

`bc_moderate_reviews` is held by `moderator` and `administrator`, **not** `platform_operator`.
The admin nav is capability-conditioned, so a platform operator will not see it and a request
returns 403. Same separation as media moderation in Phase C.

---

## 6. What the ranking now does — and why the UI matters more than it looks

`minRating` and `rating` sort have worked in the API since Phase 3 and returned nothing
useful, because every provider was 0/0. They now return sensible results, and **no screen
exposes either.**

Two behaviours worth designing around, because they will look like bugs otherwise:

- **A single 5-star review does not shoot a provider to the top.** Bayesian shrinkage pulls a
  small sample toward the platform mean: 5.0 from one review scores below 4.8 from 250. This
  is correct and deliberate.
- **A brand-new provider is not ranked at zero.** Cold-start blending puts a provider with
  little evidence mid-pack rather than last. So a filter for "4+ stars" will not simply
  reorder by average, and a UI that promises it will mislead.

The `high_rating` badge is now awardable — 4.5+ average across at least 5 reviews. It arrives
in the search document's `rankingSignalKeys` alongside `verified`, `reliable`,
`complete_profile`, and `recent_activity`. **None of these badges is rendered anywhere yet.**

---

## 7. What is NOT available

| Capability | Status |
|---|---|
| Editing a review after submission | **BACKEND GAP**, deliberate — one review per visit |
| Deleting your own review | **BACKEND GAP**, deliberate |
| Reporting a review (customer-initiated flag) | **BACKEND GAP** — the untriaged queue covers moderation without it. Phase C built the equivalent for images; say so if reviews need it |
| Reviewer display name | **PRODUCT DECISION REQUIRED** — §3 |
| Photos attached to a review | **BACKEND GAP** — Phase C's media purposes do not include one for reviews |
| Filtering or sorting a professional's own review list | **BACKEND GAP** — newest-first only |
| Rating distribution (how many 5s, 4s, …) | **BACKEND GAP** — only average and count. A histogram is a common review-UI element; it needs one query if the design wants it |
| Points clawback when a review is hidden | **PRODUCT DECISION REQUIRED** — the customer keeps their 5 points today |

---

## 8. Screens this phase implies, none designed

1. **Leave a review** — from a completed booking. Rating required, comment optional, one
   shot, no edit.
2. **Reviews on the public profile** — the list, the aggregate in the header, and the empty
   state that will be the norm for some time.
3. **Rating on a search result card** — average and count; and the no-reviews card, which is
   the majority.
4. **`minRating` filter and `rating` sort** — the two controls the gap register has been
   waiting on, with §6's caveats in mind.
5. **The professional's reply** — composition and display, per §4.
6. **`/pro` review inbox** — a professional seeing what has been said about them. No route
   exists for this yet (`GET /v1/providers/:id/reviews` is public and works, but there is no
   unanswered-reviews view). **BACKEND GAP** if the design wants one.
7. **`/admin` review queue** — triage with two equally-weighted outcomes, mirroring the
   verification and media queues that already exist.
8. **`high_rating` and the other ranking badges** — nothing renders them today.
