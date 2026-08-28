# V3.1 Phase C — Claude Design Handoff (media, portfolio, imagery)

**Baseline:** `master` after V3.1 Phase C's backend landed. `v3.1.0` and every earlier tag
untouched. **No release tag was created for this work.**
**Status:** an ADDENDUM to `V3.1.0_CLAUDE_DESIGN_HANDOFF.md`, not a replacement. That document
still describes the shipped product; this one describes capabilities the backend has gained
since, which have **no UI at all**.

## How to read this document

Every route, shape, and rule below was read out of the source tree and is covered by tests
that run against a real PostgreSQL server. Nothing here is aspirational.

The same three words are used with the same meanings as the V3.1.0 handoff:

- **IMPLEMENTABLE** — the API returns this today; design against it freely.
- **BACKEND GAP** — the behaviour is understood but no API can supply it.
- **PRODUCT DECISION REQUIRED** — nobody has decided what this should do.

One addition, because it is the whole point of this document:

- **UI REQUIRED** — the backend is complete and reachable, and no screen exists.

**Everything in §2–§6 is IMPLEMENTABLE and UI REQUIRED.** Nothing in this phase changed a
page, a token, a component, or the navigation. The only frontend-visible change is additive:
every professional shape now carries `images`.

---

## 1. What became possible

Before this phase the product had **no images anywhere**, and that was not a design gap — the
codebase had no file-upload capability of any kind. It now has:

- a professional can upload **portfolio work**, with a caption, up to 40 pieces;
- a professional can set an **avatar** and a **cover image**;
- a professional can attach **evidence documents** to a verification request, which only they
  and a moderator can ever see;
- anyone can **report** a public image, and a moderator can take it down;
- **search results and provider profiles carry imagery**, including intrinsic dimensions.

None of it is reachable by a human today. There is no upload control, no gallery, no image on
any page.

---

## 2. The upload flow — the one non-obvious interaction in this phase

Uploads are **three HTTP calls, not one**, and the middle one does not go to the API. This is
presigned direct upload: the browser sends the bytes to object storage, so a slow 8 MB mobile
upload never occupies an API connection.

```
1. POST /v1/media/upload-url        →  { mediaId, upload: { url, method, headers, expiresAt } }
2. PUT  <upload.url>                →  204     ← send the file, with upload.headers VERBATIM
3. POST /v1/media/<mediaId>/finalize →  { id, contentType, width, height, byteSize }
4. attach the mediaId wherever it belongs (portfolio / avatar / cover / evidence)
```

**Design consequences, each one real:**

- **Step 2's headers must be sent exactly as returned.** They are cryptographically signed. A
  client that substitutes its own `content-type` gets a 403 from the store that it cannot
  diagnose.
- **There are two failure surfaces, and they fail differently.** Step 2 failing is a network
  or storage problem. Step 3 failing is a *content* problem — the file was not an image, was
  too large, or had unusable dimensions — and it is the one worth a specific message.
- **Progress is only meaningful during step 2.** Steps 1 and 3 are fast round trips; step 3 is
  where the server reads the object back and checks it, so a brief "checking your image…"
  state after the transfer completes is honest rather than decorative.
- **`upload.expiresAt` is 15 minutes out.** A user who picks a file, walks away, and returns
  needs the grant re-requested, not the PUT retried.
- **The image is not attached until step 4.** A finalized-but-unattached object still counts
  against quota, so a flow that finalizes and then abandons leaks the user's own allowance.
  Attach promptly, or offer a way back to it.

### Rejection messages the API already returns (Persian, ready to display)

| Situation | HTTP | `error.code` |
|---|---|---|
| declared type not JPEG/PNG/WebP | 400 | `MEDIA_REJECTED` |
| declared size above the purpose's cap | 400 | `MEDIA_REJECTED` |
| what actually arrived is not a valid image | 400 | `MEDIA_REJECTED` |
| dimensions too small or too large | 400 | `MEDIA_REJECTED` |
| nothing was uploaded before finalize | 400 | `MEDIA_NOT_UPLOADED` |
| the user's quota for this purpose is full | 409 | `MEDIA_QUOTA_EXCEEDED` |
| too many unfinished uploads outstanding | 409 | `MEDIA_QUOTA_EXCEEDED` |
| public storage is not configured in this environment | 400 | `MEDIA_PUBLIC_STORAGE_UNCONFIGURED` |

Every message is already Persian and safe to show verbatim.

### The limits, so the UI can state them before a user hits one

| Purpose | Max size | Min edge | Max edge | Per-user quota |
|---|---|---|---|---|
| `portfolio` | 8 MB | 200 px | 8000 px | 40 |
| `avatar` | 4 MB | 200 px | 4000 px | 5 |
| `cover` | 8 MB | 400 px | 8000 px | 5 |
| `verification_evidence` | 8 MB | 200 px | 8000 px | 10 |

Accepted formats: **JPEG, PNG, WebP**. Nothing else, including SVG — refused deliberately, not
by omission.

---

## 3. Portfolio

### Routes

| Route | Auth | Returns |
|---|---|---|
| `GET /v1/providers/:id/portfolio` | **public** | ordered list of items |
| `POST /v1/providers/:id/portfolio` | owner | the created item |
| `DELETE /v1/providers/:id/portfolio/:itemId` | owner | 204 |

### Shape

```jsonc
// GET /v1/providers/:id/portfolio  →  data: [ … ]
{
  "id": "0192…",
  "caption": "کوتاهی و رنگ",       // nullable, ≤ 200 chars
  "position": 0,                     // ascending; stable
  "media": {                         // NULL if the image was taken down
    "id": "0192…",
    "url": "https://…",
    "contentType": "image/png",
    "width": 1200,                   // ← use these for the aspect ratio
    "height": 800
  },
  "createdAt": "2026-08-28T…Z"
}
```

### `media` can be `null`, and this is not an error

A moderator can take an image down. The portfolio item survives; its `media` becomes `null`.
**A single removed image must not break the gallery** — render the remaining items and omit
that one. The API deliberately does not fail the whole response.

### Zero layout shift is achievable, and here is the mechanism

`width` and `height` are the image's **intrinsic** dimensions, captured server-side at upload
from the file header. They are present for every stored image. Setting an explicit aspect
ratio from them is what makes `next/image` reserve space before the bytes arrive.

This is the one measurable Definition-of-Done item the roadmap sets for Phase C, and it is now
entirely a frontend matter — the data it needs exists.

### States

- **Empty** — a professional with no work. This is the common case at launch, on both the
  public profile and the pro editor, and it is the state most worth designing well: it is a
  supply-side prompt ("show your work") on one surface and an absence on the other.
- **Loading** — a public route with no session; the gallery is part of the profile fetch.
- **Error** — standard `ErrorState`; nothing media-specific.
- **Full** — at 40 items, `POST` returns 409 `PORTFOLIO_FULL` with a Persian message naming the
  limit. Worth surfacing before the user picks a 41st file.

### Ordering — **BACKEND GAP, deliberate**

`position` is a real integer with a per-professional uniqueness rule, and items come back
ordered. There is **no reorder endpoint**: ordering is a UI affordance, and the affordance does
not exist yet. New items append to the first free slot; deleting the last item frees it for
reuse. If the design calls for drag-to-reorder, that is a small backend addition — flag it and
it will be built.

---

## 4. Avatar and cover

| Route | Auth | Body | Returns |
|---|---|---|---|
| `PATCH /v1/providers/:id/avatar` | owner | `{ "mediaId": "0192…" \| null }` | 204 |
| `PATCH /v1/providers/:id/cover` | owner | `{ "mediaId": "0192…" \| null }` | 204 |

`null` **clears** the image. It must be sent explicitly — an omitted field is a validation
error, not a clear, because clearing somebody's avatar by accident is not recoverable.

Every professional shape now carries, always present:

```jsonc
"images": {
  "avatar": { "id": "…", "url": "…", "contentType": "image/png", "width": 512, "height": 512 },
  "cover":  null
}
```

Present on `GET /v1/providers`, `GET /v1/providers/:id`, `GET /v1/me/provider`, and
`PATCH /v1/providers/:id`. `null` means "not set", never "not supported".

**Replacing an avatar deletes the old one.** There is no history and no undo. A confirmation
step before replacing is a design choice worth considering; the backend will not offer a way
back.

---

## 5. Verification evidence — the surface with the strictest rules

Phase A shipped a verification queue that could carry only a text note, and its migration
recorded why: no file-upload capability existed. It does now.

| Route | Auth | Notes |
|---|---|---|
| `POST /v1/verification/evidence` | own open request | `{ mediaId }`, purpose must be `verification_evidence` |
| `GET /v1/verification/me/evidence` | self | own documents, each with a `downloadUrl` |
| `GET /v1/admin/verification/:id/evidence` | `bc_moderate_verification` | one request's documents, each with a `downloadUrl` |

### Rules the UI has to respect

- **Evidence attaches only to an OPEN request.** Submit first, then attach. Attaching to a
  decided request is refused with 409 — attaching after a decision would change what the
  moderator's decision was based on.
- **At most 5 documents per request.** A reviewer reads these by hand.
- **`downloadUrl` expires in 5 minutes and is minted for one viewer.** It is not a permanent
  URL: do not cache it, do not put it in a `src` that outlives the page, and re-fetch the list
  rather than reusing a link. Authorization is re-checked on every request, so a link that
  worked a moment ago can legitimately stop working.
- **These images must never appear in a public context.** They have no public URL at any layer
  — `media.url` is `null` for them by construction — but the design should not put them
  anywhere a screenshot or a shared link could leak them either.
- **This is somebody's identity document.** Treat the moderation screen accordingly: no
  thumbnails in a list a colleague could shoulder-surf, an explicit action to open, and no
  bulk gallery view.

---

## 6. Reporting and moderation

### Anyone signed in can report a public image

`POST /v1/media/:id/report` — `{ reason, note? }`

`reason` is one of `not_own_work` · `explicit` · `misleading` · `personal_data` · `other`.
`note` is free text up to 1000 characters. One open report per person per image; a second
returns a conflict.

**PRODUCT DECISION REQUIRED:** where the report control lives. The backend accepts a report
against any public media id; whether that is an affordance on every portfolio image, on the
profile as a whole, or behind an overflow menu is a product and design question nobody has
answered.

### Moderators triage the queue

| Route | Capability |
|---|---|
| `GET /v1/admin/media/reports` | `bc_moderate_media` |
| `POST /v1/admin/media/reports/:id/decide` | `bc_moderate_media` |

`decide` takes `{ decision: "uphold" | "reject", reason }` — `reason` is **required in both
directions**, 4–500 characters, matching the verification-decision contract exactly.

**Upholding removes the image permanently.** The bytes are deleted, the portfolio item's
`media` becomes `null`, and an audit row records who did it and why. There is no restore. The
UI should make that irreversibility legible before the action, not after.

### Who holds this capability — read this before designing the admin nav

`bc_moderate_media` is held by **`moderator` and `administrator`**, and deliberately **not** by
`platform_operator`. The existing admin shell's nav is capability-conditioned; a platform
operator will not see this section, and asking for it returns 403. That is the rule working,
not a gap: approving a verification must not confer the power to remove somebody's published
work.

---

## 7. Search results now carry imagery

The provider search document gained five fields:

```jsonc
"avatarUrl": "https://…" | null,
"avatarWidth": 512 | null,
"avatarHeight": 512 | null,
"portfolioCount": 7,
"portfolioPreviewUrls": ["https://…", "…"]   // at most 4
```

- `portfolioPreviewUrls` is **capped at four** by the producer. A result card can show up to
  four thumbnails without the payload becoming a second copy of the gallery.
- `portfolioCount` is the true total, so "+3 more" is expressible.
- A provider with no imagery returns `null` and `0` — very common at launch. **The result card
  has to look right with no image at all**, and that state is not a fallback, it is the norm
  until the supply side uploads.
- Imagery survives the degraded path: if the search engine is unavailable, results are served
  from PostgreSQL and still carry these fields. An engine outage costs relevance, not pictures.

---

## 8. What is NOT available, so no design assumes it

| Capability | Status |
|---|---|
| Thumbnails / resized renditions / WebP conversion | **BACKEND GAP** (`GAP-C-02`). One URL per image, at its original size. A card showing a 4000 px photo downloads a 4000 px photo. If the design needs renditions, say so — it is a real piece of work with a real decision behind it, not a switch. |
| Cropping, rotation, filters, any editing | **BACKEND GAP.** The server never modifies bytes. |
| Portfolio reordering | **BACKEND GAP**, deliberate — §3. |
| Alt text / accessible descriptions | **BACKEND GAP.** `caption` exists for portfolio items and is display copy, not alt text. **This one matters**: without it every uploaded image is undescribed to a screen reader. Flag it if the design needs it and it will be added — it is one nullable column. |
| Video, PDF, or any non-image upload | **BACKEND GAP**, deliberate. Three image formats only. |
| Business (as opposed to professional) imagery | **BACKEND GAP.** `provider.professionals` gained the columns; `business.businesses` did not. |
| Customer avatars | **BACKEND GAP.** No purpose exists for one. |
| Image in reviews | **FUTURE — Phase D**, which does not exist yet. |

---

## 9. Screens this phase implies, with nothing designed

Listed as capabilities to represent, not as a proposed information architecture:

1. **Upload** — a control that can carry the three-step flow, its two distinct failure
   surfaces, and a per-purpose limit stated up front. Reused by at least four contexts
   (portfolio, avatar, cover, evidence) with different limits and different consequences.
2. **`/pro` portfolio management** — the gallery in an editable state: add, caption, remove,
   the full-quota state, and the empty state that asks a professional to show their work.
3. **`/pro/profile` imagery** — avatar and cover, with replacement being destructive.
4. **Public profile gallery** — the customer-facing view, where zero layout shift is the
   measurable requirement.
5. **Search result imagery** — avatar plus up to four previews, and the no-imagery state that
   will be the majority for some time.
6. **Verification evidence** — attach on the professional's side; a deliberately austere
   reviewer's view on the moderator's, per §5.
7. **Report control** — placement is a product decision (§6).
8. **`/admin` media reports** — a queue and a decision, mirroring the verification queue that
   already exists, with irreversibility made legible.

---

## 10. One thing the design pass should know about the environment

`GET /health` now reports which storage driver is running and whether it is `durable`. In
development and CI it is the local filesystem driver (`durable: false`) — real, working, and
serving real bytes from the API's own host, which means **image URLs in a development
environment point at the API, not at a CDN**. In production they will point wherever the
chosen provider serves from. Design against the shape of the URL, never its origin.

The storage vendor itself is still undecided — it is downstream of the hosting decision
(`V3.1_PRODUCT_ROADMAP.md` §12 #1) — but that changes only an environment variable, never a
response shape.
