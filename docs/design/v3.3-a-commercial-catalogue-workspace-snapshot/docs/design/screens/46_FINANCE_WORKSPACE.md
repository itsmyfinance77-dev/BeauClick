# Screen 46 — Persona-neutral finance workspace (#152 / `#149b`)

**Baseline:** `itsmyfinance77-dev/BeauClick@master` → commit **`5d4b3de5d7b386d14dc72c5bbd03f17fead64b38`**
**Story:** #152 (`#149b`), `status:proposed`, `sp:5`, `track:design`
**Binding:** `V33-DEC-038`, `V33-DEC-020`, `V33-DEC-021`, `V33-DEC-037`, ADR-049 §5
**Prototype:** `Prototype - Finance Workspace.dc.html` (§F0–F5)
**Backend:** implemented (#72, #111, #154 closed). **Frontend: designed, not implemented.**

## 1. Route and persona

A new destination at `/finance`, **not** `/pro/finance` with a different title, and **not** behind
`ProGuard`, `ProShell` or any requirement for a professional profile. It serves the business owner,
the professional owner, the dual owner, the finance-only staff member with no professional profile,
and the user reaching several finance workspaces.

`/pro/finance` remains for compatibility. Both routes render **one shared finance-workspace
component**; the legacy route delegates to it. A single-professional owner's behaviour is unchanged
and no existing owner is silently redirected into a different persona. **No new backend route is
designed.**

Navigation label: **«امور مالی»** — neutral. A finance-only staff member is never called «متخصص» in
any title, shell, sidebar or badge.

## 2. The five workspace-aware routes, and nothing else

| Route | Response fields used |
|---|---|
| `GET /v1/me/finance/workspaces` | `workspaceRef`, `workspaceType` (`professional`\|`business`), `accessMode` (`owner`\|`finance_read`), `displayLabel` |
| `GET /:workspaceRef/summary` | `partyType`, `receivableNetToman`, `settledToman`, `outstandingToman`, `currency` |
| `GET /:workspaceRef/outstanding-orders` | the settlement service's outstanding-order projection |
| `GET /:workspaceRef/settlements` | `items[]{id, kind, amountToman, currency, method, reference, createdAt}`, `nextCursor` |
| `GET /:workspaceRef/orders/:orderId/ledger` | `{id, entryType, amountToman, currency, commissionRateBp, referenceType, createdAt}` |

No route accepts a party. The caller comes from the session; the workspace comes from an opaque
reference that is **matched, never looked up**. Page size defaults to 20 and is capped at 100. The
cursor is opaque and workspace-bound — one issued by another workspace is refused before a row is
read. A `finance_read` holder reads these same five routes with the same projection and nothing
else; the four legacy singular routes remain ownership-only and never show a grant.

`commissionRateBp` on a ledger row is rendered as **the rate recorded on that historical
transaction**, never as a current or approved platform rate. No rate figure is stated as policy.

## 3. Workspace selection

- **Never** auto-select `items[0]` when several workspaces exist. Nothing is shown until one is
  chosen.
- **Never** display, decode or truncate `workspaceRef`, and never expose a raw party id.
- The active workspace is visually explicit.
- Owned versus delegated read-only access is distinguished by **text plus shape** — filled circle for
  owner, hollow square for delegated — never by colour alone.
- A workspace reachable both by ownership and by grant appears **once**, as owner access (the server
  already de-duplicates with `owner` winning; the UI does not re-derive it).
- Multi-workspace selection is never reduced to an invisible implicit state.
- A caller with exactly one workspace sees no selector: the destination opens directly.

### Workspace identity comes from the server

`FinanceWorkspaceEntry.displayLabel` is the public name of the business or professional, resolved
server-side from the authoritative source for exactly the addressable set, in one bulk call. It is
**presentation metadata, never an authorization input**; authority is still re-read on every
request. A party whose public source row is gone is omitted from the response entirely, so there is
no "unnamed workspace" state to design.

The selector therefore shows:

| Element | Source |
|---|---|
| Primary title | `displayLabel` |
| Supporting context | `workspaceType` — «کسب‌وکار» / «تخصصی» |
| Access badge | `accessMode` — owner (filled circle) / delegated read-only (hollow square), text **and** shape |
| Nothing | `workspaceRef` — never displayed, decoded, shortened, persisted or reasoned about |

No label is generated locally, derived from response order, or numbered. **Workspace labels are
supplied by the server and are not generated from client-side ordering or session-local numbering.
They may change when the underlying public business or professional name changes.**

**Residual, documented limitation.** Two workspaces may legitimately share a `displayLabel`. Type
and access mode usually separate them; when label, type and access mode are all identical, the UI
has nothing safe left to differentiate with, and it **does not invent one** — no ordinal, no
invitation order, no fragment of the reference. The list stays in the server's stable order and both
entries are selectable. Recorded here as a non-blocking limitation rather than papered over.

Long Persian labels truncate visually with the full label available to assistive technology and on
hover, and never push the access badge off the card.

## 4. Content and data minimisation

Rendered: the three summary figures exactly as returned, outstanding orders, the settlement page,
the per-order ledger, cursor pagination, empty history, API error, partially available sections,
long numbers with Persian digit grouping, and mixed RTL/LTR runs only where the API already exposes
an identifier.

Not introduced anywhere: customer PII, professional identity, internal party ids, payment
credentials, grant or membership identifiers, audit metadata, invented commission, invented
settlement timing, invented payout minimum, invented reserve percentage, or a label such as
«درآمد شما» that the backend does not establish.

The `finance_read` view uses the same projection as the owner view, with its read-only status
visibly stated and **no disabled write controls** — a disabled button is an implied promise.

## 5. Revocation and stale-access recovery

Page open → owner revokes → the next request returns the existing non-enumerating refusal → cached
financial data is cleared → the inaccessible workspace is removed from selection → the user lands on
the remaining workspaces or a no-access state. No cause-specific detail is ever shown.

One neutral message covers all of: the business still existing, membership removed, grant revoked,
reference malformed, never had access. Also designed: stale reference after reload, business soft
deletion, membership becoming inactive, valid token with revoked authority, logout and account
switch.

## 5-a. The twenty states this screen covers

| # | State | Where |
|---|---|---|
| 1 | Loading workspaces | §F1 · skeleton, `aria-busy`, nothing selected |
| 2 | No accessible workspace | §F4 · empty list is a correct answer, not an error |
| 3 | One owner workspace | §F3 · no selector, destination opens directly |
| 4 | One `finance_read` workspace | §F4 · opens directly, read-only banner persists |
| 5 | Several business workspaces with distinct real names | §F1 |
| 6 | Business + professional workspace | §F1 · type carries the distinction |
| 7 | Same `displayLabel` on more than one workspace | §F1 · separated by type/access mode; no ordinal invented (§3) |
| 8 | Explicit selection required | §F1 · never auto-selects `items[0]` |
| 9 | Workspace data loading | §F4 · no stale figure under a skeleton |
| 10 | Summary success | §F2 · exactly the three server figures |
| 11 | Empty settlement history | §F4 · zeros shown as zeros |
| 12 | Paginated settlement history | §F2 · real cursor, no page numbers |
| 13 | Per-order ledger | §F2 · recorded rate never stated as policy |
| 14 | Generic inaccessible / not-found | §F4 · one message, no cause |
| 15 | Access revoked during the session | §F4 · clear, remove, return to remaining workspaces |
| 16 | `409 finance_workspace_selection_required` | §F4 · opens the selector; never says which workspace was meant or how many exist |
| 17 | Network / generic failure | §F4 · distinct from a refusal |
| 18 | Retry | §F4 · offered on failure only, never on a refusal |
| 19 | Narrow / mobile selector | §F3 |
| 20 | Long Persian labels | §F1 · visual truncation, full label exposed accessibly |

## 6. Cache and privacy annotations (implementation requirements)

- No financial response in `localStorage`, `sessionStorage` or any persistent browser storage.
- In-memory/query cache partitioned by authenticated user **and** `workspaceRef`.
- Cache cleared on logout and on account change.
- Workspace-specific cache invalidated on `401`/`403`/`404` authorization loss.
- Previous workspace data removed **before** another workspace renders.
- No stale figure ever remains beneath an access-denied message.

`Cache-Control: private, no-store` is **implemented** on the finance surface as of #154
(`V33-DEC-038` R10): a route-family middleware mounted on the `MyFinanceController` prefix sets it
before every guard, so all nine authenticated finance routes carry it on successes and on the
relevant `401`/`404`/`409` outcomes alike. The previous "missing `no-store`" warning is resolved.

The header does **not** replace the six client-side rules above. It stops a browser or intermediary
storing a response; it does nothing about data already held in the page's own memory when the
selected workspace changes, access is revoked, the user signs out, or a finance request returns an
inaccessible authorization result.

## 7. Responsive

- **Desktop** — explicit workspace selector beside the finance content hierarchy.
- **Tablet** — selector stays visible; finance sections stack predictably.
- **Mobile** — workspace cards first, then the selected workspace's summary; «امور مالی» is a bottom
  tab destination. Workspace titles wrap to two lines before truncating.
- Wide settlement and ledger tables become labelled card rows on mobile — not horizontally scrolling
  tables. Amount columns stay aligned across cards.
- Cursor pagination stays reachable and keyboard operable at every width; there is no page number or
  total count, because the server returns neither.

## 8. Accessibility

Verified in the design: `<fieldset>`/`<legend>` around workspace selection with real radios; ≥44px
targets; status by text + shape; `role="alert"` on the refusal; `role="note"` on the design-review
annotation; real `<table>` with `<caption>` and `<thead>`; tabular numerals with aligned amount
columns; `dir="ltr"` isolation on any LTR run; a truncated workspace title keeps its full
`displayLabel` available to assistive technology rather than exposing only the visible fragment;
workspaces are chosen from native radio controls, so keyboard selection never depends on visual
order.

Requires testing at implementation (not claimed as PASS): tab order, focus trap and focus return in
any dialog, computed accessible names for workspace actions, keyboard operation of the selector,
live-region announcement of workspace switching and of access revocation, screen-reader RTL order,
measured contrast, real-device target size, reduced-motion.

**No WCAG 2.1 AA conformance is claimed from a static prototype.**
