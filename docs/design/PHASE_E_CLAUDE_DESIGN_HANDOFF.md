# V3.1 Phase E — Claude Design Handoff (privacy, devices, and the resend button)

**Baseline:** `master` after V3.1 Phase E's backend landed. `v3.1.0` and every earlier tag
untouched. **No release tag was created for this work.**
**Status:** an ADDENDUM to `V3.1.0_CLAUDE_DESIGN_HANDOFF.md`,
`PHASE_C_CLAUDE_DESIGN_HANDOFF.md`, and `PHASE_D_CLAUDE_DESIGN_HANDOFF.md`.

Same vocabulary as the earlier handoffs — **IMPLEMENTABLE**, **BACKEND GAP**,
**PRODUCT DECISION REQUIRED**, **UI REQUIRED**.

---

## 1. What became possible

A user can now obtain everything the platform holds about them, and can leave. Both work end
to end through the API, against real PostgreSQL, including the seven-day window in which
leaving can still be undone.

None of it is reachable by a human. There is no privacy screen, no download button, no
deletion flow, no device list that means anything, and no countdown on the resend button.

Four items of this phase's roadmap scope are **still blocked on decisions, not on
engineering**, and are listed in §8 so they are not mistaken for oversights.

---

## 2. The privacy screen — **UI REQUIRED**

One screen, four actions. Everything below is live.

### Getting your data

```jsonc
POST /v1/privacy/export          // no body
// 202
{ "id": "...", "kind": "export", "status": "pending",
  "requestedAt": "...", "executeAfter": null, "expiresAt": null,
  "completedAt": null, "cancelledAt": null, "failureCode": null }
```

**202, not 201, and `status: "pending"` — the document does not exist yet.** Generation
happens on a background sweep, typically within a minute. A UI that treats the response as
"your file is ready" will send the user to a download that 404s.

```jsonc
GET /v1/privacy/export/:id       // poll, or just re-open the screen
// 200 — same shape; watch `status` and `expiresAt`

GET /v1/privacy/export/:id/download
// 200
{ "byteSize": 48213, "checksumSha256": "…", "expiresAt": "…",
  "document": { "documentVersion": 1, "subjectUserId": "…", "generatedAt": "…",
                "sections": { … }, "retained": [ … ] } }
```

### States the screen must handle

| `status` | What the user sees |
|---|---|
| `pending` | "We are preparing your data." No download. |
| `processing` | Same as `pending`, visually — the distinction is operational, not a user-facing step |
| `ready` | Download, **with the expiry date shown** |
| `expired` | The file is gone. Offer to request a new one — this is a normal end state, not an error |
| `failed` | Something went wrong; offer to request again |

**`expiresAt` is not decoration.** The document is destroyed 72 hours after generation, not
merely hidden. A screen that shows a download button without saying until when will produce
users who come back on Thursday to a file that no longer exists.

### The document

`sections` is keyed `moduleKey.sectionKey` — `identity.account`, `booking.bookings`,
`provider.reviews_written`, `loyalty.points`, and so on. Each section carries a Persian
`description` written for the subject, so the file explains itself without this codebase.

`retained` is a list of `{ module, table, reason }` — everything the platform deliberately
kept and why, mostly the financial ledger and the administrative audit log. **This is worth
surfacing in the UI, not just leaving in the JSON.** "We kept your payment records because we
are legally required to" is a better answer than a user discovering the omission themselves.

The download is a JSON body, not a file attachment. If the screen should offer a `.json` file,
the client constructs the blob — there is deliberately no signed URL, because a link to a
complete personal-data export survives being forwarded and proxy-logged.

### Leaving

```jsonc
POST /v1/privacy/deletion
{ "confirm": "DELETE" }          // exact string, required, case-sensitive
// 202
{ "id": "...", "kind": "erasure", "status": "pending",
  "executeAfter": "2026-09-04T…",  // ← the deadline. Show it.
  … }

POST /v1/privacy/deletion/:id/cancel
// 200 — same shape, status "cancelled"
```

`confirm: "DELETE"` is required and must match exactly. It is not a substitute for
authentication — the session already proves who is asking — it is the guard against the
one-tap mistake, and the string is deliberately not localised so it cannot be typed by
accident. **The UI must show the literal string the user has to type**, not a translated
approximation of it.

### The rules a UI has to respect

- **`executeAfter` is the whole point of the flow.** Nothing is destroyed until then, and the
  user can cancel right up to it. A confirmation screen that says "this cannot be undone" is
  actively wrong — for seven days, it can.
- **Cancelling restores nothing, because nothing was destroyed.** There is no "restoring your
  account" state and no delay. The account was never impaired.
- **The account stays fully usable during the window.** Do not disable anything, do not show a
  banner implying the account is already gone.
- **One open request of each kind at a time.** A second `POST` while one is open returns
  `409 CONFLICT` with a Persian message that is safe to display. The screen should show the
  existing request instead of offering to create another.
- **After execution there is nothing to show.** Every session is revoked and the phone number
  no longer resolves, so the user is signed out and cannot sign back in. Design the *last*
  screen they see before that.

### Errors, already Persian and safe to display

| Situation | HTTP | `error.code` |
|---|---|---|
| a request of this kind is already open | 409 | `CONFLICT` |
| request id not yours, does not exist, not generated yet, or expired | 404 | `NOT_FOUND_OR_NOT_YOURS` |
| erasure no longer cancellable (already cancelled, or already executing) | 404 | `NOT_FOUND_OR_NOT_YOURS` |
| `confirm` missing or wrong | 400 | `VALIDATION_ERROR` |

Rows two and three are **one refusal for several situations by design** — distinguishing them
would let anyone probe other people's request ids and their states. Do not try to render a
more specific reason; there is not one.

### Notifications the user will already have received

In-app, and the category cannot be switched off:

| Template | When |
|---|---|
| `privacy_export_requested` | on request |
| `privacy_export_ready` | when downloadable — carries `expiresAtDate` |
| `privacy_erasure_requested` | on request — carries `executeAfterDate` |
| `privacy_erasure_cancelled` | on cancel |

There is deliberately **no notification when erasure completes**: by then there is no channel
left and no account to sign into.

---

## 3. Device management — **UI REQUIRED**, and now actually buildable

`GET /v1/auth/sessions` was returning `current: false` on every row, which is why no device
screen was ever designed: a list of indistinguishable sessions with a "sign out" button next
to each is a trap.

```jsonc
GET /v1/auth/sessions
// 200
[ { "id": "…", "deviceLabel": "iPhone", "userAgent": "…",
    "createdAt": "2026-08-05T…",   // when THIS DEVICE signed in
    "lastUsedAt": "…", "revoked": false, "current": true } ]

DELETE /v1/auth/sessions/:id      // 200 { "revoked": true }
```

Three things changed, and each affects the design:

- **`current` is real.** Exactly one row is the session asking. Mark it, and either disable or
  clearly differentiate its sign-out control.
- **One row per device, not one per refresh.** The list used to grow every fifteen minutes of
  ordinary use. It no longer does.
- **`createdAt` is when the *device* signed in**, carried across every token rotation — so
  "since 5 Mordad" is now true rather than "eleven minutes ago" for every device.

**Every row can legitimately have `current: false`.** That happens for an access token minted
before this change, for up to fifteen minutes after a deploy. Design for it: do not assume
exactly one row is always marked, and do not fall back to guessing.

`deviceLabel` comes from the `x-device-label` request header the client sets at sign-in. It is
**Latin-1 only** — an HTTP header cannot carry Persian text — so a client sending a Persian
label will fail the request outright. Either send an ASCII identifier and translate it for
display, or send nothing.

---

## 4. The OTP screen — **UI REQUIRED** (`QA-19`)

```jsonc
POST /v1/auth/request-otp
{ "phone": "09121234567", "purpose": "login" }
// 200
{ "requested": true, "cooldownRemaining": 60, "expiresInSeconds": 120 }
```

**These are two different numbers and confusing them is the bug this exists to prevent.**
`expiresInSeconds` is how long the code is valid; `cooldownRemaining` is how long until a
resend is accepted. A screen counting the expiry down would enable resend while the cooldown
still had a minute to run, and the user would tap it into a 429 — which is exactly the
behaviour `QA-19` was filed about.

On a refusal inside the window:

```jsonc
// 429
{ "error": { "code": "RATE_LIMITED", "message": "…",
             "details": { "retryAfterSeconds": 43 } } }
```

`details.retryAfterSeconds` may be **absent**, and when it is, that is meaningful rather than
missing: the hourly limit fired instead of the resend cooldown, and when *that* window resets
genuinely is not knowable. Show the Persian message and do not invent a countdown.

`requested: true` is returned whether or not the phone has an account, and so are both
numbers. That is the anti-enumeration guarantee — **the UI must not branch on any of them** in
a way that reveals account existence.

---

## 5. The admin privacy queue — **UI REQUIRED**

`GET /v1/admin/privacy/requests?page=&limit=&status=` — requires `bc_manage_platform`.

Returns status and timing only: `id`, `subjectUserId`, `kind`, `status`, `requestedAt`,
`executeAfter`, `expiresAt`, `completedAt`, `cancelledAt`, `failureCode`.

**Two things an operator cannot do, and the UI must not imply otherwise:**

- **Read a payload.** There is no route. The export document is reachable by exactly one
  principal, the subject.
- **Cancel somebody's erasure.** There is no route, and that is deliberate — an operator who
  can cancel a deletion can silently keep an account its owner asked to be rid of. When a
  request is stuck, `status: "failed"` and `failureCode` are what an operator acts on.

This is a monitoring surface, not a control surface. Design it that way.

---

## 6. What is NOT available

- **No email or SMS notification of any of this.** In-app only. The SMS provider port is built
  and tested but no vendor is configured (`GAP-11`), so `providerVerified` is `false` and
  nothing leaves the building.
- **No export of another user's data, by anyone, ever.**
- **No partial or scoped export** — the document is everything or nothing.
- **No re-download after expiry.** Request a new export.
- **No account "reactivation" after erasure completes.** The window is the only way back.

---

## 7. Screens this phase implies, none designed

1. **Privacy / account settings** — export request, status, download with expiry, deletion
   request, the countdown to `executeAfter`, and cancel.
2. **The deletion confirmation** — the exact-string confirm, the seven-day window stated
   plainly, and what survives (payment records, and why).
3. **Device management** — the list, `current`, and revoke.
4. **OTP entry** — a resend button that counts down `cooldownRemaining` and a separate expiry
   for the code itself.
5. **Admin privacy queue** — read-only, filterable by status.

---

## 8. Still blocked, and not on engineering

These four are Phase E roadmap scope and were deliberately not built. They are decisions, not
oversights.

| Item | Blocked on |
|---|---|
| **Terms, privacy policy, contact, support** (`QA-23`) | **Legal content someone must author and approve** (#14). The markup is trivial; shipping an empty footer or links to 404s is worse than shipping nothing. This pairs naturally with the privacy screen above — the policy and the mechanism should be written together. |
| **Vazirmatn** (`QA-17`) | **The font-delivery decision** (#15) — self-host a Latin+Arabic subset via `next/font/local`, or CDN. The UI/UX audit's #1 recommendation, and the one finding that affects every pixel of Persian text. |
| **A designed homepage** (`QA-16r`) | No approved design. Imagery now exists (Phase C), so it is worth doing properly. |
| **Favicon, OG/Twitter, robots, sitemap** (`GAP-09` frontend half) | Nothing but design and copy. Any link shared into a messaging app currently renders bare, in a market where sharing happens in messaging apps. |
