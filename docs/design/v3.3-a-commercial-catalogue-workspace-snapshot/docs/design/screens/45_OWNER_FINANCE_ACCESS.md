# Screen 45 — Owner finance-access management (#149 / `#149a`)

**Baseline:** `itsmyfinance77-dev/BeauClick@master` → commit **`5d4b3de5d7b386d14dc72c5bbd03f17fead64b38`** (requested and inspected; the repository did not advance during the pass)
**Story:** #149 (`#149a`), `status:proposed`, `sp:3`, `track:design`
**Binding:** `V33-DEC-038`, `V33-DEC-037`, `V33-DEC-033`, `V33-DEC-030`, `V33-DEC-020`, ADR-049 §4–5 (clarified 2026-09-12)
**Prototype:** `Prototype - Pro and Admin.dc.html` §25
**Backend:** implemented (#109, #111, #154 closed). **Frontend: designed, not implemented.**

## 1. The exact contract this screen drives

| Method | Route | Body | Returns |
|---|---|---|---|
| GET | `/v1/businesses/:id/staff-management` | — | `{ items: [{ id, role, status, displayLabel, labelSource, identificationHint, roles }] }` |
| GET | `/v1/businesses/:id/staff/:staffId/grants` | — | `{ roles: ScopedStaffRole[] }` |
| POST | `/v1/businesses/:id/staff/:staffId/grants` | `{ role }` | `{ roles }` |
| POST | `/v1/businesses/:id/staff/:staffId/grants/revoke` | `{ role }` | `{ roles }` |

All four are `@ResolveOwner(BusinessOwnerResolver)` — **live owner only**. The body is exactly one
closed literal from a two-member vocabulary; the whitelist pipe refuses any other field with a
`400`, so no owner, user, phone, professional or business id can be sent.

`GET /v1/businesses/:id/staff` — the general roster, readable by every active member — is
**unchanged** and this screen reads no identity from it. The owner-only
`staff-management` read is a sibling path, resolved live and in bulk, and stored nowhere.

The grant response carries **live roles only** — no grant id, no `grantedAt`, no `revokedAt`, no
actor. Everything the screen renders about authority comes from that array.

### 1-a. Field → UI mapping

| Field | Type at the contract | Where it lands |
|---|---|---|
| `displayLabel` | `string`, always present | The row's primary identity, and the name repeated in the confirmation dialog |
| `labelSource` | exactly `professional` \| `phone` (`STAFF_LABEL_SOURCES`) | Chooses the **presentation form only**. Never rendered as text to the owner |
| `identificationHint` | `string`, always present, exactly the final four digits of the verified phone | The row's secondary identification line, part of every action's accessible name, and the differentiator between two members with the same `displayLabel` |
| `role` | `manager` \| `staff` | Secondary line |
| `status` | `invited` \| `active` | Secondary line; `invited` rows carry no action control |
| `roles` | live scoped roles | `finance_read` present → active badge + Revoke; absent → no-access badge + Grant; `practitioner_chat` → its own square badge |
| `id` | membership id | Request path only. **Never rendered.** |

### 1-b. The one presentation rule this design adds

When `labelSource` is `phone`, the server's `displayLabel` **is** the four digits —
`displayLabel === identificationHint` — because that member has no live professional profile. Four
bare digits are not a name, so the screen renders them inside a fixed Persian frame,
«شمارهٔ منتهی به …», and does not repeat the hint on a second line for that row. The frame adds no
digit, no separator and no invented identity: it is the four server-supplied characters plus a
label that says what they are. Digits are rendered verbatim in a `dir="ltr"` isolated run, so an RTL
line never reorders them.

No full phone number, email, `userId`, `professionalId`, invitation order or array index appears
anywhere, and no label is ever constructed from one.

## 2. Authority rules the screen must make explicit

- Only the **live business owner** grants or revokes. A manager, a staff member, the grantee
  themselves and a stranger all receive the same refusal.
- Membership alone confers nothing. The membership must be `active`; `invited`, `inactive`,
  `declined` and `removed` are not grantable.
- A finance-only member may have **no professional profile**. `professional_id = NULL` is valid for
  `finance_read` and is the typical bookkeeper case — the grant service passes
  `requireProfessionalLink: false` for it.
- `practitioner_chat` is a different role on a different axis and **does** require the professional
  link. The two never merge into one control.
- The vocabulary is closed. No new scoped role is invented in the UI.
- **Frontend visibility is not authorization.** Authority is never cached in a token, session or
  memo; the server re-reads it on every request, so revocation takes effect on the next one.

## 3. Copy

The Persian label is **«دسترسی فقط‌خواندنی مالی»**. The internal literal `finance_read` appears only
in the developer annotation, never as primary user-facing copy.

The capability explanation — what the grantee can read (summary, outstanding orders, settlement
history, per-order ledger of this one business) and what they cannot (change settlements, payouts,
refunds or ledger facts; select or cancel a subscription; buy booking credit; assign a
collection policy; manage commercial policy; administer staff authority) — is **standing informational
copy above the roster**, not a step in the grant path. The revoke dialog carries its own consequence
description.

### 3-a. Grant has no confirmation dialog

`V33-DEC-037`/#149 make granting **reversible**, so it requires no confirmation step. Activating the
grant button submits immediately. There is no dialog, sheet, popover, warning or second click, and
none was substituted for the removed one. The button itself carries the member's identity
(`displayLabel` + masked hint) in its accessible name, which is what a confirmation would otherwise
have supplied.

During submission the control is disabled and `aria-busy`, so a duplicate submission cannot be sent.
Start, success and failure are announced through a polite live region that names the member. On
success the row's roles are redrawn from the server's response; on failure the previous row state is
preserved and a retry control, associated with the error through `aria-describedby`, takes its place.

**Revocation keeps its dialog** — it removes live access and is disruptive. The dialog names the
exact member, names the access being revoked, carries `aria-labelledby`/`aria-describedby`, offers
cancel and a destructive confirm, exposes pending/success/failure/retry, and returns focus to the
invoking row control on cancel or completion.

## 4. Twenty states

1. **Roster loading** — row skeletons with `aria-busy`; no action control before real state arrives.
2. **Roster loaded, several distinguishable members** — each row shows its own `displayLabel`, its
   four-digit hint, membership role and status, and exactly one action.
3. **Professional-name label** — `labelSource: professional`: the public name is the primary
   identity, the hint sits on the secondary line.
4. **Finance-only member, masked hint** — `labelSource: phone`: «شمارهٔ منتهی به …» as the
   primary identity, no duplicated hint line. This is the bookkeeper persona, and it is a correct
   state rather than a defect.
5. **Two members sharing one `displayLabel`** — distinguished by the hint alone, which therefore
   appears in the visible row, in the action's accessible name and in the confirmation dialog.
6. **Roster empty** — nobody is a member yet; inviting is the only action.
7. **No eligible member** — members exist, none `active`; copy says granting becomes possible after
   the invitation is accepted.
8. **Eligible, no grant** — hollow-ring badge + «بدونِ دسترسیِ مالی» + a grant button that submits
   immediately when activated (no confirmation — §3-a).
9. **Active grant** — filled-circle badge + «فعال» + a revoke button in place of the grant button.
10. **Grant in progress** — button disabled and `aria-busy`; the status badge has **not** changed.
11. **Grant success** — the badge is drawn from the server's returned `roles`, never from a client
    guess; live region announces it.
12. **Grant idempotent / already granted** — the server applies the grant idempotently and returns
    the same live-roles array. The UI shows that result, invents no "already granted" error, and
    reconciles the row to the response.
13. **Grant failure** — the row returns to its previous state; the error is tied to an accessible
    retry control with `aria-describedby`.
14. **Revoke confirmation** — modal naming the exact displayed member (label + hint), with an
    explicit acknowledgement checkbox; a full-screen sheet on mobile.
15. **Revoke in progress** — the dialog stays open with its buttons disabled.
16. **Revoke success** — dialog closes, focus returns to the row's button, row moves to "no access".
17. **Membership removed between read and mutation** — the roster was read, the membership then
    ended, and the grant or revoke now returns the single neutral refusal. The list is re-read and
    the row, with its control, is removed; no copy says whether the membership ever existed.
18. **Membership removed or inactive at read time** — the row is not grantable and its button is
    *removed*, not disabled.
19. **Owner authority lost mid-action** — return to the safe roster state, remove every stale
    actionable control, show the neutral refusal.
20. **Network/server failure** — distinct from a refusal: retryable, row states untouched.

Two behaviours run through all twenty: the **non-enumerating refusal** is one message for every
cause (it does not say whether the business exists, whether the membership existed, or whether a
grant was ever held), and every **revocation confirmation names the exact member shown in the row**.

**Revoked-grant history is still not readable.** The grant response carries live roles only; the
revoked row persists in the database and the audit log with no read route. The screen shows no
history. #154 did not change this, and it remains a bounded, non-blocking backend follow-up.

## 5. Responsive

- **Desktop** — structured roster rows: identity, membership role, status, access badge, one action.
- **Tablet** — same rows; identity, role and status are preserved and the action is not compressed.
- **Mobile** — one card per member; the action is full-width and separated from navigation.
- Confirmation dialogs become full-screen sheets on mobile; the action row pins above the safe area.
- **Grant and Revoke never sit adjacent.** A row is in exactly one of the two states, so it carries
  exactly one of the two buttons — the adjacency hazard is removed structurally, not by spacing.

## 6. Accessibility

Verified in the design: ≥44px targets; shape + text on every status badge (hollow ring = no access,
filled circle = active, square = practitioner-chat authority); `role="dialog"` + `aria-modal` +
`aria-labelledby` + `aria-describedby` on the **one** dialog this screen has (revoke); `role="status"`
+ `aria-live="polite"` regions for grant and revoke progress and result; errors associated with their
retry control through `aria-describedby`; disabled reasons stated in adjacent text; logical
properties and `dir="ltr"`
isolation on code runs **and on every four-digit hint**, so a masked hint is never reordered or
visually corrupted in an RTL line.

Identification-specific rules, verified in the markup:

- The hint is **never the sole accessible name**. Each action's accessible name is
  label + hint together («اعطای دسترسیِ فقط‌خواندنیِ مالی به سارا رضایی، شمارهٔ منتهی به 0002»).
- Two rows sharing a `displayLabel` therefore expose two **different** accessible names, so a screen
  reader user never chooses between two identical options.
- Selection and confirmation are reachable by keyboard without relying on visual order: rows are a
  list of native controls, and the revoke dialog repeats the identity in its own title.
- Grant is a single activation on an identified control, so no focus is moved and none has to be
  restored; revoke moves focus into its dialog and returns it to the invoking control.
- Progress, result and failure are announced in a live region rather than only shown; no state change
  depends on motion, and no entrance animation carries meaning (reduced-motion safe).

Requires testing at implementation (not claimed as PASS): tab order, focus trap, focus return,
computed accessible names, live-region announcement of grant/revoke progress and result,
screen-reader RTL reading order, measured contrast, real-device target size, reduced-motion.

## 7. Member identifiability — resolved by #154

**Historical note (design pass of 2026-09-12, superseded the same day):** at baseline `b54bb846af09`
the only roster read returned raw `userId`/`professionalId` UUIDs with no name and no phone, so this
screen used neutral row labels and recorded member identifiability as a bounded backend follow-up.
**That follow-up is closed.** #154 (`V33-DEC-038`) shipped the owner-only `staff-management` read
described in §1, and this screen now consumes it. No anonymous placeholder, invitation-order label or
raw identifier remains in the design.

What the design still does not do, because the contract still does not: show a revoked-grant
history (§4), and show any identity beyond `displayLabel` + the four-digit hint.

## 8. Scope boundary

Not designed here, and not requested: batch grants, bulk revocation, search by phone, identity
lookup, invitation creation, staff creation or removal.
