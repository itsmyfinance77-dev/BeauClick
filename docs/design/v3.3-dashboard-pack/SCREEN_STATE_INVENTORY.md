# Screen × state inventory (#45)

Seven states per surface (screen 51 §7): **L** loading · **E** empty · **X** error · **C** conflict · **U** unavailable · **R** capability or authority revoked · **P** partial configuration.

How to read a cell:

- **S‹n›** means the state is **drawn** for that surface in prototype section S‹n›.
- **◦** means the state applies and uses the generic pattern drawn once in the S12 catalogue. It is not drawn again per surface.
- **spec ‹n›** means an existing spec already draws it and this pack does not redraw it.
- **n/a** is always followed by the reason the state cannot occur.

## 1. Shell and contexts

| Surface | L | E | X | C | U | R | P |
|---|---|---|---|---|---|---|---|
| Header + AvatarMenu (51 §2.1–2.2) | ◦: `/v1/me` pending, so brand only and no context entries | n/a: an authenticated session always has the customer context | ◦: header without context entries plus a page-level retry | n/a: read-only | n/a: an entry the caller cannot use is **absent** (S1, second menu), never unavailable | S9 · ◦ | n/a |
| Messages entry (51 §2.1) | no badge until answered | `total = 0` means no badge | no badge and no number | n/a | absent without `bc_use_chat` | removed with the entry | n/a |
| Workspace selector (51 §2.3) | **S2** | **S2** | **S2** | **S2** (`409 finance_workspace_selection_required`) | n/a | spec 46 §5 | n/a |
| Admin entry and label (51 §2.2, 52 §2) | as header | n/a | as header | n/a | n/a | S9 | n/a |

## 2. Landings

| Surface | L | E | X | C | U | R | P |
|---|---|---|---|---|---|---|---|
| Customer `/dashboard` (51 §3.1) | spec 03 | spec 03 | spec 03 | n/a | **S3** (booking without an order; dispute filing) | n/a: customer capabilities are not revoked per page | **S3** (customer policy copy unpublished) |
| Professional «وضعیت تجاری» (51 §3.2) | ◦ | n/a: an owner always has exactly one professional entry | ◦ | **S4** (`purchase_unavailable`) | **S4** (usage, credit balance) | ◦ via `ProGuard` | **S4** (`subscription: null`) |
| Business owner (51 §3.3) | spec 12 | ◦ (no team, no locations: a sentence plus the owner action) | spec 12 | owner-write refusals inline (spec 42) | ◦ (usage, as S4) | ◦ (soft-deleted business → member or no-business view) | ◦ (unclassified business, legal per `V33-DEC-032`; no plan, as S4) |
| Manager (51 §3.4) | ◦ | ◦ (a roster of one) | ◦ | `PATCH` validation refusal inline | n/a: what a manager cannot do is **stated** (**S6**), not unavailable | ◦ (membership inactive) | n/a |
| Reception (51 §3.5) | ◦ | ◦ | ◦ | n/a | **S6** (delegated booking) | ◦ | n/a |
| Practitioner (51 §3.6) | as professional | as professional | as professional | n/a | n/a | grant revoked: conversations disappear server-side (**S6** shows the entry) | n/a |
| Finance-read `/finance` (51 §3.7) | spec 46 #1, #9 | spec 46 #2 | spec 46 #17 | spec 46 #16 | n/a | spec 46 #15 | n/a |
| Moderator landing (52 §3) | **S8** (per card) | **S8** («صف خالی است») | **S8** (per card) | n/a | n/a: a queue not held is **absent** | **S9** | n/a |
| Media decision panel (52 §5) | 52 §5 table | spec 27 | 52 §5 table | n/a | **S10** (image not addressable → uphold disabled) | 52 §5 table | n/a |
| Platform operator / administrator `/admin` | unchanged (spec 20) | unchanged | unchanged | unchanged | unchanged | ◦ | unchanged |

## 3. Money and commercial facts

| Fact | Source | L | E / zero | X | C | U | R | P |
|---|---|---|---|---|---|---|---|---|
| Collection mode, service total, online-now, venue balance | `GET /v1/orders/:id` → `paymentSchedule` | ◦ | a `0` is drawn as zero (for example online-now under `pay_at_venue`) | ◦ | n/a | **S3** (no `orderId`: no money line) | n/a | n/a |
| Collected / refunded (customer) | `collectedTotalToman`, `refundedTotalToman` | ◦ | refunded hidden when `0`, collected `0` drawn | ◦ | n/a | n/a | n/a | n/a |
| Subscription and entitlements | `GET /v1/me/subscriptions` | ◦ | an entitlement of `0` is «بدون سهمیه» (**S4** note) | ◦ | selection or cancel `409` inline | n/a | write refused → ◦ | **S4** |
| Subscription usage | no route | — | — | — | — | **S4** | — | — |
| Booking-credit balance / consumption | no route (internal only) | — | — | — | — | **S4** · S12 | — | — |
| Credit purchases | `GET …/credit-purchases` | ◦ | ◦ (none yet) | ◦ | **S4** (`purchase_unavailable`) | paid activation (**S4**, #99) | ◦ | ◦ (no published credit schedule) |
| Pending / available / disputed / reserve / settled / refunded | `GET …/funds` | 46 amendment §E3 | 46 amendment (all zero is a correct answer) | 46 amendment §E3 | n/a | n/a | spec 46 §5 | n/a |
| Custody facts / platform money | `GET …/funds` | as above | as above | as above | n/a | n/a | as above | n/a |
| Legacy summary | `GET …/summary` | spec 46 | spec 46 | spec 46 | spec 46 #16 | n/a | spec 46 | n/a |
| Reversed | settlements, `kind = 'reversal'` | spec 46 | no reversals means no rows | spec 46 | n/a | n/a | spec 46 | n/a |
| Seller-owed receivable (`V33-DEC-040`) | no route (#177) | — | — | — | — | **S7** | — | — |
| Disputes and appeals | no route (#162, #180) | — | — | — | — | **S3**, **S11** | — | — |
| Customer remedy / no-show | `GET /v1/bookings/:id/remedy`, `…/no-show` | spec 49 | spec 49 | spec 49 | spec 49 | spec 49 | spec 49 | spec 49 |
| Customer policy copy / legal seller block | screen 47 copy family | spec 41/47 | n/a | spec 41 | n/a | n/a | n/a | **S3** |

## 4. Widths

The shell sections are drawn at the widths their captions state (1280, 768 and 390 artboards). The whole prototype document is measured at **390, 768 and 1280** for overflow, contrast and structure (`AUDIT.md` §3–§5), and each section is captured at all three in `screenshots/`.
