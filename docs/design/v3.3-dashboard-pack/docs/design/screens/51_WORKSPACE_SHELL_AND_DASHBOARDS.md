# 51 — One authenticated shell, workspace switching, and capability-driven dashboards (#45)

**Story:** #45, `type:story`, `sp:13`, `track:design`, milestone V3.3. **Design only.**
**Implementation baseline:** `master` = `2e3da4a43482680db5104c1e78dba48a8d2a18f4` (V3 CI run 334 green).
**Design baseline:** `design/claude-design` = `4b5b120f3493b76f0ba4147d0712d1afbaea2293`. The canonical snapshot `v3.3-a-commercial-catalogue-workspace-snapshot/` is **not modified**; this pack cites it.
**Prototype:** `Prototype - Workspace Shell and Dashboards.dc.html` (§S0–S12).
**Companions:** `52_MODERATOR_LANDING.md` · `../../../PERSONA_CAPABILITY_MATRIX.md` · `../../../ROUTE_CONTRACT_MATRIX.md` · `../../../SCREEN_STATE_INVENTORY.md`.
**Binding decisions:** `V33-DEC-018` (a subscription per owned party), `V33-DEC-020` (affiliation is not financial ownership), `V33-DEC-030` D1/D3/D4, `V33-DEC-033` R1, `V33-DEC-037`, `V33-DEC-038` (R7 server labels, R10 no-store), `V33-DEC-039` (frontend/design consequences), `V33-DEC-040`, `V33-DEC-041`, `V33-DEC-042`, ADR-049 §5, ADR-052 §12/§16, and the product owner's approved moderator-experience recommendation **A** (recorded for #264 in the V3.3 continuation brief of 2026-09-25: one shared admin shell with a capability-driven moderator landing).

---

## 1. What this screen is, and what it is not

It is the **frame** every authenticated screen sits in. It decides which contexts a person can enter, which workspace a workspace-addressed screen acts on, what each landing page shows, and how every money or commercial fact is labelled and stated when it is unavailable.

It does **not** redesign the screens it frames. Customer dashboard (03), professional today (04), business (12), finance (13/45/46 and the 46 amendment), admin overview (20), moderation queues (21/27/28/37), mobile navigation (25), accessibility (26), seller commercial and operations (42) and screens 47–50 keep their own specs. Where this document changes one of them, it says so explicitly (§12 lists each amendment).

Three rules hold everywhere and are not repeated in each section:

1. **Every value comes from the server.** The prototype renders no amount, count, percentage, date, deadline or legal sentence. Each value slot shows the wire field that fills it, for example `‹settledToman›`. An implementation that cannot name the field it renders is inventing a number.
2. **Navigation visibility is never authorization.** Every route guard and every API keeps its own check. The shell *hides* what the caller cannot use; the server *refuses* it.
3. **Absent is not zero, and zero is not absent.** A figure the server returned as `0` renders as a zero. A figure no route returns renders as an explicit *unavailable* state that names why. It never renders as `0`, `—` or a skeleton that never resolves.

## 2. One shell

There is one authenticated identity: `GET /v1/me` → `{ id, phone, displayName, roles, capabilities }`. The server resolves it **live** from `identity.user_roles` on every call, so a revocation changes the shell at the next `/v1/me` read and not at the next token. "Persona" in this document is never a stored type. It is a name for a combination of live capabilities, live roles and live workspace addressability.

### 2.1 Header anatomy (≥ 1024 px)

`brand · primary (خدمات · متخصص‌ها · حساب من) · [context chip] · messages · bell · AvatarMenu`

| Element | Source | Rule |
|---|---|---|
| Context chip | derived from the current route prefix | Shown only outside the customer context: «حالت متخصص», «کسب‌وکار», «امور مالی», «مدیریت» or «بررسی محتوا» (see §2.2). It is text plus a tinted band, never colour alone. |
| Messages | `GET /v1/chat/unread-count` → `total`, `conversations` | Shown only when `capabilities` contains `bc_use_chat`. The count is in the accessible name. `0` shows no badge. A read failure shows no badge and no number, never a guessed one. The destination belongs to #237. |
| Bell | `GET /v1/me/notifications/unread-count` → `unreadCount` | Unchanged from the built `AppShell`. |
| AvatarMenu | `/v1/me.displayName`, falling back to `phone` | Holds **context switching** (§2.2) and the occasional destinations the IA already places there. |

Below 640 px the header keeps brand, bell and avatar, and navigation moves to `MobileTabBar` per spec 25. Contexts are switched from «حساب» (customer) or from the professional sheet (seller). The admin dark bar keeps its own «خروج از پنل مدیریت».

### 2.2 Contexts, and who may enter each

A **context** is a family of routes with its own navigation. A **workspace** is the seller or business party a workspace-addressed route acts on (§2.3). The two are different axes. The switcher never merges them into one list, because the same person can be in the finance context, reading a workspace they do not own, while also owning a professional workspace.

| Context | Route prefix | Offered in the AvatarMenu when | Guard that actually decides |
|---|---|---|---|
| Customer | `/`, `/dashboard`, `/bookings` … | always (authenticated) | session |
| Professional | `/pro` | `roles` contains `professional` (granted with the profile, V3.3 #75) | `ProGuard` + `GET /v1/me/provider`; each API derives the party from the session |
| Business | `/business` | always offered (as today). The page itself resolves whether the caller owns a business (`GET /v1/me/business`) or holds memberships (`GET /v1/me/business-staff`) | per-handler `BusinessOwnerResolver` / `BusinessManagerResolver` / `BusinessMembershipResolver` |
| Finance | `/finance` | always offered (Story #152: a finance-only member owns nothing, so any condition would hide their one destination) | live ownership or live `finance_read` grant, per request |
| Admin, full | `/admin` | `capabilities` contains `bc_manage_platform` | `CapabilityGuard` per route, live re-check for privileged capabilities |
| Admin, moderation only | `/admin` | `capabilities` contains any `bc_moderate_*` and **not** `bc_manage_platform` | same guard. Landing per screen 52 |

**The admin entry is one shell with two labels.** A caller holding `bc_manage_platform` sees «مدیریت» and the full overview. A caller holding only moderation capabilities sees «بررسی محتوا» and the moderator landing (screen 52). There is one layout, one dark bar and one route. What differs is which destinations are offered and what `/admin` renders. This amends the built `AppShell` (today it offers `/admin` only for `bc_manage_platform`) and the built `app/admin/layout.tsx` (today it guards the whole shell on `bc_manage_platform`). Both amendments are implemented by #264, not by this design.

**Order in the menu** is fixed and never depends on how many contexts the caller has: customer · professional · business · finance · admin. A context the caller cannot enter is **absent**, never disabled. A disabled entry is an implied promise (spec 42 §4).

### 2.3 Workspaces and switching

Three facts shape this section:

- A seller's workspaces are **opaque, server-issued references** (`workspaceRef`). They are never displayed, decoded, shortened, persisted, placed in a URL, sent to analytics or compared across surfaces (46 §3). Each surface uses the references its own collection returned.
- There are **two** workspace collections today and they answer different questions:
  - `GET /v1/me/finance/workspaces` → `{ workspaceRef, workspaceType, accessMode, displayLabel }`. Owned **and** reachable through a live `finance_read` grant, each once, owner winning. This is the only list with a server-supplied name.
  - `GET /v1/me/subscriptions` → `{ workspaceRef, workspaceType, subscription, baseWorkspace, availableActions }`. **Owned only**, with no label. Because `uq_professionals_owner_id` and the partial `uq_businesses_owner_id` allow at most one live workspace of each type per owner, `workspaceType` identifies the workspace uniquely within this list. The name shown beside it comes from the caller's own `GET /v1/me/provider` or `GET /v1/me/business`, which are already self-scoped.
- The policy screens (48, 42 §3) choose among owned workspaces from the finance list filtered to `accessMode = 'owner'`. That is a compromise recorded in #210, and this design keeps it: a dedicated seller workspace list is #210's to add. This design needs no such route.

**Switching rules (all surfaces):**

1. **One addressable workspace:** no switcher. The surface opens it directly and names it in the page heading.
2. **Several:** nothing is selected until the person chooses. Never `items[0]`, never "the last one used" from storage. The selector is a `<fieldset>` of real radios (46 §8).
3. **Each option shows:** the name (`displayLabel`, or the owned name per the rule above), the type as text («تخصصی» / «کسب‌وکار»), and the access mode as **text plus shape**: a filled circle and «مالک» for `owner`, a hollow square and «فقط‌خواندنی — دسترسی واگذارشده» for `finance_read`.
4. **On switch,** the previous workspace's data is removed **before** the next one renders. There is no cross-fade and no stale figure under a skeleton.
5. **Where the choice lives:** in memory for the page session only. A reload with several workspaces asks again. This is the price of never persisting a reference, and it is stated to the person once, in the selector's hint.
6. **Duplicate names** (same label, type and access mode) are shown as the server ordered them. No ordinal is invented (46 §3, residual limitation).

### 2.4 Capability and authority revocation, live

| What changed | What the person sees | Mechanism |
|---|---|---|
| A capability removed (e.g. `bc_moderate_media`) | At the next `/v1/me` read, the destination leaves the nav. If they are on that page, its next API call returns `403` and the page shows the **capability-revoked** state: «دسترسی شما به این بخش تغییر کرده است.» with one action «بازگشت», which goes to the context landing. No data from before the refusal stays on screen. | `/v1/me` is re-read on every navigation into `/admin` and on any `403` from an admin route. `CapabilityGuard` re-reads privileged grants per request. |
| All admin capabilities removed | The admin entry leaves the AvatarMenu. `/admin` shows the existing no-access state, not the moderator landing with zero cards. | `AdminGuard` |
| A `finance_read` grant revoked or a membership inactive | The next finance request returns the shared refusal. The workspace leaves the selector and the person lands on the remaining workspaces or the no-access state (46 §5). | per-request grant re-read |
| Ownership lost (business soft-deleted) | Same as above on finance and subscription surfaces. | per-request ownership re-read |
| `bc_manage_own_subscription` revoked | **Not live.** It is non-privileged by decision (`V33-DEC-019`), so it takes effect at the next token issue. The design must not claim otherwise. The write control stays until the server refuses it, and the refusal renders the capability-revoked state. | stated, not hidden |

## 3. Dashboards by persona

Each row in `PERSONA_CAPABILITY_MATRIX.md` gives the exact capabilities, roles, memberships and grants behind a persona. The landing each persona sees is below. "Landing" means the page a context opens on; nothing here is a new route.

### 3.1 Customer — `/dashboard` (spec 03, built)

Unchanged apart from three facts:

- **Upcoming booking money** (§5.1). When `GET /v1/me/bookings` returns an `orderId` (#225, merged), the card may show the order's collected and venue facts from `GET /v1/orders/:id`. With no `orderId`, the card shows no money line at all, not «۰».
- **Joined date** stays **absent** until `/v1/me` carries `createdAt` (#226). No placeholder line is drawn.
- **Messages** entry (§2.1) when `bc_use_chat` is held. The destination belongs to #237.

### 3.2 Solo professional — `/pro` (spec 04, built)

Today's content is unchanged. Added, as one bounded card «وضعیت تجاری» that links out and does not duplicate the other screens:

- **Plan:** the subscription for the `professional` entry of `GET /v1/me/subscriptions`: `subscription.state`, `effectiveAt`, and the plan's `displayName` when `GET /v1/me/commercial-plans` lists that exact `planKey`/`version`. When it does not (for example a retired version), the card says «طرح جاری» with no name. `planKey` is an administrative key and is never shown. If `subscription` is `null`, the **partial-configuration** state applies: «طرحی برای این فضا ثبت نشده است.», with the action offered only if `availableActions` is non-empty.
- **Entitlements** as quantities: `includedBookingCredits`, `staffSeats`, `includedLocations`. A `0` is rendered as zero and labelled «بدون سهمیه» (absence of entitlement, never "unlimited", spec 42 §1).
- **Usage:** the **unavailable** state (§5.3).
- **Money:** a link to «امور مالی» and **no figures on `/pro`**. The finance figures belong to `/finance`, which owns the workspace selection, cache and revocation rules. Two places computing the same figure is how they drift.

### 3.3 Business owner — `/business` (spec 12, built) + operations (spec 42 §4)

The owner is the only persona for whom every business route answers. The landing groups what exists:

| Block | Routes | Notes |
|---|---|---|
| Business profile | `GET /v1/me/business`, `GET /v1/businesses/:id`, `GET …/classification` | vertical and traits are shown as facts and **grant nothing** (`V33-DEC-030` D1). The dashboard never branches on a vertical. |
| Team | `GET /v1/businesses/:id/staff-management` → `displayLabel`, `labelSource`, `identificationHint`, `roles` | owner-only. The hint is the final four digits the owner supplied and is never widened (`V33-DEC-038` R4–R5). |
| Scoped grants | `GET …/staff/:staffId/grants` → `practitioner_chat`, `finance_read` | the vocabulary is exactly these two. No other grant is drawn. |
| Locations and resources | `GET /v1/businesses/:id/locations` and children | owner-only, per spec 42 §4 |
| Plan and entitlements | the `business` entry of `GET /v1/me/subscriptions` | as §3.2 |
| Money | link to «امور مالی» | as §3.2 |

A **dual owner** (professional and business) enters two contexts. The professional context shows the professional workspace and the business context shows the business workspace. Neither shows both, and neither chooses for them (`V33-DEC-018`).

### 3.4 Manager — `/business` as an active `manager` member

From `GET /v1/me/business-staff` (`role = 'manager'`, `status` active) and `GET /v1/businesses/:id` (`BusinessMembershipResolver`):

- **May:** read the business, its classification and the membership-level roster (`GET …/staff`). Edit the business profile (`PATCH /v1/businesses/:id`, `BusinessManagerResolver`). Use chat for the business's customer conversations when the seller-access port allows it (`V32-DEC-010`, owner and active managers).
- **Is shown, as a stated fact:** «مدیریت اعضا، دسترسی‌ها، شعبه‌ها و منابع فقط با مالک کسب‌وکار است.» This is a sentence, not a set of disabled buttons.
- **Money:** nothing, unless the owner granted `finance_read`, in which case the workspace appears in «امور مالی» as delegated (§3.7). Affiliation alone grants no finance (`V33-DEC-020` Ruling 1).
- **Own work:** if the manager also owns a professional profile, their own `/pro` context is separate and unchanged.

### 3.5 Reception — an active `staff` member with no grant

**No reception role, capability or scoped grant exists.** `V33-DEC-030` and `V33-DEC-033` R1 keep delegated calendar authority an explicitly OPEN decision, and no route lets one member act on another's calendar. The design therefore does **not** draw a reception desk, a shared calendar or a booking-on-behalf flow. What a reception employee actually has:

- the membership-level business read and roster (as a manager, without `PATCH`);
- their own customer context, like everyone else;
- a single stated fact on `/business`: «ثبت و مدیریت نوبت برای دیگر اعضا در این نسخه ممکن نیست.» (**unavailable**, not "coming soon", and with no date).

### 3.6 Practitioner — an active `staff` member who owns a professional profile

- **Own professional context** (`/pro`) exactly as §3.2, acting on **their own** professional workspace. Their bookings, availability and finance are their own, and never the salon's.
- **With a `practitioner_chat` grant:** chat access to the booked practitioner's **own** customer conversations and nobody else's in the salon (`V33-DEC-033` R2). The dashboard shows only the messages entry (§2.1). Which conversations appear is the server's decision per request.
- **Without the grant:** no business conversations. Nothing is shown that implies they exist.

### 3.7 Finance-read grantee — `/finance`, `accessMode = 'finance_read'`

Screen 46, the 46 amendment and spec 45 apply unchanged. What this design adds is only the shell behaviour: the grantee reaches `/finance` from the AvatarMenu (always offered) and sees the delegated badge (hollow square plus «فقط‌خواندنی») on the selector **and** on the page heading of the selected workspace. There are no write controls, disabled or otherwise. A grantee who owns nothing sees no professional or business context content beyond the membership read (§3.4/§3.5).

### 3.8 Moderator — `/admin`, moderation capabilities only

Screen 52.

### 3.9 Platform operator — `/admin` with `bc_manage_platform`

The built overview (spec 20, `#259`/`#272`) and every `bc_manage_platform` destination, **unchanged**. A platform operator holds no `bc_moderate_*`, no `bc_moderate_chat` and no `bc_manage_commercial_plans`, so those destinations are absent from their bar exactly as today. The overview does not gain moderation cards for them.

### 3.10 Administrator — `/admin` with every admin capability

**Unchanged.** The full overview plus every destination, including the four moderation queues and the four commercial destinations. The moderator landing is **not** shown to a caller holding `bc_manage_platform`. Their `/admin` is the overview, as today.

### 3.11 Verticals: laser centre, maison, retail, B2B

A business's vertical (`salon | clinic | maison | retail | wholesale | academy`) and traits (`multi_location | mobile`) are commercial classifications that grant **no** permission, capability, financial access or booking authority (`V33-DEC-030` D1). The dashboards are therefore identical across verticals. There is no laser-centre dashboard, no maison dashboard and no retail dashboard. A vertical is displayed as a fact on the business profile. `clinic` introduces no medical data anywhere. B2B quotes and campaigns are epic #17 (`status:decision`) and have no route, so nothing is drawn for them.

## 4. Owner versus delegated access

`accessMode` is the only server fact that says **how** a session reaches a workspace. It is rendered everywhere a workspace is named, as text plus shape:

| `accessMode` | Shape | Text | Writes offered |
|---|---|---|---|
| `owner` | filled circle ● | «مالک» | whatever that surface's owner routes permit |
| `finance_read` | hollow square ▢ | «فقط‌خواندنی — دسترسی واگذارشده» | **none**, and none drawn disabled |

Delegation exists **only** on the finance surface. The subscription, policy, operations and team surfaces are owner-only by construction, so a delegated reader never sees them for the delegating business.

## 5. Money and commercial facts

Each fact has one label, one source and one owner. `SCREEN_STATE_INVENTORY.md` §3 lists each fact's states.

### 5.1 Customer: deposit and venue balance (order detail)

From `GET /v1/orders/:id` (the customer who owns the order, `OrderOwnerResolver`):

| Fact | Field | Label | Rule |
|---|---|---|---|
| How this booking is collected | `paymentSchedule.collectionMode` ∈ `pay_at_venue` · `deposit_online_balance_at_venue` · `full_payment_online` | «پرداخت در محل» · «پیش‌پرداخت آنلاین، باقی در محل» · «پرداخت کامل آنلاین» | closed vocabulary. An unknown value renders «نامشخص» and is never mapped to the nearest known one |
| Service total | `paymentSchedule.serviceTotalToman` | «مبلغ خدمت» | never labelled as paid |
| Online amount due now (the deposit or full amount) | `paymentSchedule.platformCollectibleNowToman` | «مبلغ پرداخت آنلاین» | never computed from the other two |
| Remaining at the venue | `paymentSchedule.venueBalanceToman` | «باقی‌مانده، پرداخت در محل» | a **schedule** figure. BeauClick records no venue payment, so the card never says it was paid |
| Actually collected | `collectedTotalToman` | «پرداخت‌شده» | the only figure called "paid" |
| Refunded | `refundedTotalToman` | «بازگشت‌داده‌شده» | shown only when non-zero |

**Legal seller and BeauClick's own charges** (`V33-DEC-042`): the receipt shows the snapshotted seller by name and kind as «فروشندهٔ خدمت», with BeauClick's charges separate. The customer-facing responsibility sentences come **only** from administrator-published, versioned copy (screen 47's copy family). Until one is published, the block renders «متن شرایط هنوز منتشر نشده است.» and never a hard-coded sentence.

### 5.2 Subscription usage (seller)

What is readable: the plan, its state, its entitlements (`includedBookingCredits`, `staffSeats`, `includedLocations`, `capabilityKeys`), its price (`unitPriceToman`, `currency`), `effectiveAt`, history (`supersededAt`, `cancelledAt`) and `availableActions` (`select_plan`, `cancel`).

What is **not** readable: consumption against any entitlement. There is no seat-usage, location-usage or credit-usage route. The design therefore shows **entitlements, not usage**, under the heading «سهمیهٔ طرح», and one **unavailable** line: «میزان مصرفِ سهمیه در این نسخه نمایش داده نمی‌شود.» It never counts staff rows or locations on the client and presents that as seat or location usage, because what counts as a used seat is not ratified.

### 5.3 Booking-credit usage (seller)

- **Balance and consumption:** **unavailable.** The balance is derived server-side (grants − consumptions + returns, `BookingCreditAccountingService.balanceFor`), but no route exposes it to the seller. The design shows «ماندهٔ اعتبار رزرو در این نسخه قابل نمایش نیست.» and **no number**.
- **Included credits:** `includedBookingCredits`, as a quantity (never money, never "unlimited").
- **Purchases:** `GET …/credit-purchases` → `purchaseId`, `quantity`, `unitPriceToman`, `totalToman`, `state` ∈ `awaiting_payment` · `abandoned`, `effectiveAt`, `createdAt`. Paid activation is blocked externally (#99, #47). The purchase flow therefore stops at `awaiting_payment`, labelled «در انتظار پرداخت — پرداخت آنلاین هنوز فعال نیست». A quote refusal is the single non-enumerating `purchase_unavailable`, rendered as one neutral sentence.
- **Refund of unused purchased credit** (`V33-DEC-041` R6): the affordance is **absent** until a rail and its story exist. The design notes the future place for it in the prototype annotation, not in the UI.

### 5.4 Seller funds: pending, available, disputed, settled, refunded, reversed

The 46 amendment applies **with its reviewer corrections R1–R3**: three bounded blocks (this workspace's money, custody facts, platform money), no total across or within them, and nine of twelve fields structurally zero today. This design adds only:

- **Reversed** is not a funds field. It is a settlement **row** whose `kind = 'reversal'` in `GET …/settlements`. It is rendered in the settlement history as «برگشت تسویه», with the amount as returned (the server mirrors it negatively) and no recomputed net.
- **Pending money** has two server sources that answer different questions: `summary.outstandingToman` (legacy, receivable not yet settled) and `funds.pending` (new regime, collected and not yet moved on). They stay under separate headings with the 46 amendment's sentence that they do not add up.

### 5.5 Seller receivable: two opposite meanings, kept apart

| Term | Direction | Server fact | Rendering |
|---|---|---|---|
| `summary.receivableNetToman` | owed **to** the seller (legacy receivable + available + reserve + settled) | exists | «طلب خالص شما» under the legacy block, as 46 already does |
| `V33-DEC-040` "seller receivable" | owed **by** the seller (a deduction beyond collected money, or a post-settlement refund recovery) | **does not exist** (#177, `#43f`, proposed) | **unavailable**: «بدهیِ ثبت‌شده به سکو در این نسخه نمایش داده نمی‌شود.» and never shown as a negative balance |

The two must never share a label, a card or a sign convention.

## 6. Disputes, appeals, remedy and no-show

| Surface | Contract | Rendering |
|---|---|---|
| Customer files a dispute (category, including `bodily_harm`) | **none** (#162, `#42e`, proposed, `gate:legal`) | **unavailable** on the booking: «ثبت اعتراض در این نسخه فعال نیست.» No form, no category list and no window countdown are drawn |
| Completed-booking objection | **none** (#180, `#42f`) | same |
| Reviewer queue, decision and appeal | **none**. `V33-DEC-039` R11 requires a new privileged capability that does not exist | **absent** from the moderator landing and the admin bar. Not drawn as a disabled card |
| Disputed money on the seller side | `funds.disputed` | as §5.4. Structurally zero until disputes exist |
| Customer remedy after a seller cancellation or no-show | `GET /v1/bookings/:id/remedy`, `GET /v1/bookings/:id/no-show` | screen 49, owned by #212 (`status:ready`). This design only places its entry point on the customer booking card when the remedy read says a choice is open |

## 7. States

Every surface in §3–§6 has the seven states below. The per-surface table is `SCREEN_STATE_INVENTORY.md`.

| State | Meaning | Rendering rule |
|---|---|---|
| **loading** | a read is in flight | skeleton per block with `aria-busy="true"`. Never a stale figure underneath. The page frame renders immediately |
| **empty** | the server answered and there is nothing, for example no bookings, no workspaces or no settlements | a sentence stating it plus, where one exists, the single next action. Zero figures stay zeros (46 amendment §A-5) |
| **error** | the read failed (network or 5xx) | `role="alert"` scoped to the failing block only, with «تلاش دوباره». Other blocks keep rendering (spec 03) |
| **conflict** | `409`: `finance_workspace_selection_required`, a publish or overlap refusal, an idempotency replay | opens the selector or states the refusal in one sentence. It never says which workspace was meant or how many exist |
| **unavailable** | no route exists, or an external gate is closed | a dashed-border block with the fact's label and one sentence of why, with **no number, no date and no "coming soon"** |
| **capability-revoked** | a `403` or shared refusal after the page had access | the block is cleared, then §2.4 applies. **No retry** on a refusal, because retry is offered for failures only |
| **partial configuration** | the mechanism exists but nothing is published or assigned: no plan (`subscription: null`), no published collection or outcome policy, no published credit schedule, no customer copy | a neutral sentence naming what is not yet configured, never styled as an error. The action is offered only if the server lists it (`availableActions`) |

## 8. Responsive

Breakpoints are the built tokens: **< 640**, **640–1023**, **≥ 1024** (`breakpoints.spec.ts`).

| Width | Shell | Dashboards |
|---|---|---|
| **390** | header (brand, bell, avatar) plus `MobileTabBar` per context (spec 25). The admin context has the dark bar, horizontally scrolling, and no bottom bar | single column. Workspace selector first, as full-width radio cards. Wide tables become labelled card rows (`DataTable`). Money cards keep their amounts aligned. Every target ≥ 44 px (`bc-tap`) |
| **768** | full header, primary links collapse into the AvatarMenu only if they do not fit | two columns where the source spec allows. The selector stays visible above the content |
| **1280** | full header. `/pro` keeps the 248 px column | the selector sits beside the content. Dashboards use the source spec's column layout |

There is no horizontal page scroll at any width (`scrollWidth === innerWidth`). This is verified for the prototype at 390, 768 and 1280 (see `AUDIT.md` §3).

## 9. RTL and Persian

`dir="rtl"`, `lang="fa"`. Persian digits for every number (`toPersianDigits`), with digit grouping «٬». Toman as the unit **once per block** (`MoneyUnitNote`, #294), never per figure. Jalali dates. Times and any Latin identifier isolated with `dir="ltr"` and `unicode-bidi: isolate`. The shape badges (● ▢) sit at the logical start. Chevrons and "next" arrows are mirrored. Long Persian workspace names wrap to two lines before truncating, with the full name in the accessible name.

## 10. Keyboard and WCAG 2.1 AA

- **Order:** skip link → header → context bar → page. Tab order equals visual order in RTL. Shift+Tab is its mirror, with no trap outside dialogs (spec 26).
- **AvatarMenu** is a disclosure button (`aria-expanded`) with a list of links. Escape closes it and returns focus to the button. Arrow keys are not required, because they are links rather than a menu role.
- **Workspace selector** is a `<fieldset>` + `<legend>` with native radios. Arrow keys move within the group and Space selects. The change is announced by an `aria-live="polite"` line: «فضای کاری: ‹displayLabel›».
- **Moderator cards** (screen 52) are headings with one link each. The count is in the link's accessible name.
- **Focus ring:** 2 px `primary` with 2 px offset on every interactive element. `outline: none` is never used without a replacement.
- **Contrast:** text ≥ 4.5:1, large text and UI components ≥ 3:1, using the corrected palette pinned by `contrast.spec.ts`. The prototype's own pairs are measured in `AUDIT.md` §4.
- **Status by text and shape,** never colour alone: access mode, unavailable (dashed border plus a sentence), revoked (an icon plus a sentence).
- **Reduced motion:** no animation carries information.
- **Not claimed:** a static prototype proves layout and markup, not conformance. Screen-reader passes, real-device target size and live-region timing must be verified at implementation (the same limit spec 26 and screen 46 state).

## 11. Privacy and isolation rules

1. A workspace-addressed response is cached in memory only, partitioned by user **and** `workspaceRef`, cleared on logout, account change, workspace switch and any `401`/`403`/`404` (46 §6).
2. No finance, booking, message or moderation content in `localStorage`, `sessionStorage`, URLs, analytics, console output or error messages.
3. No figure crosses a persona boundary. A manager's dashboard never shows business money. A practitioner's dashboard never shows the salon's. A moderator never sees platform statistics.
4. No customer identity on any seller or moderator dashboard beyond what the existing route already returns to that caller.
5. Medical or health data does not exist in any contract used here, and `clinic` introduces none.
6. Admin statistics (`/v1/admin/analytics`, finance totals, audit) are `bc_manage_platform`-only and never reach the moderator landing.

## 12. Amendments to existing specs (made by this design, implemented elsewhere)

| Spec | Amendment | Implemented by |
|---|---|---|
| 20 ADMIN_OVERVIEW | `/admin` renders the overview only for `bc_manage_platform`. Otherwise it renders the moderator landing (52) | #264 |
| 25 MOBILE_NAVIGATION | the admin dark bar lists only the destinations the caller holds. A moderator's bar has one to four entries | #264 |
| 27 ADMIN_MEDIA_MODERATION | the decision panel's image states (52 §5) | #265 |
| 03 CUSTOMER_DASHBOARD | joined date stays absent until `createdAt` exists | #226 |
| 13 PRO_FINANCE / 46 | the four-month `MoneyChart` trend uses a server series, never a browser aggregation of the paged history | #255 |
| 36 INTERNAL_CHAT | the header messages entry (§2.1) is the entry point | #237 |
| 42 §5 | superseded for funds by the 46 amendment (the funds model now exists) | — (documentation) |

## 13. Backend gaps this design renders as unavailable (no new field is designed)

| # | Gap | Rendered as | Tracked |
|---|---|---|---|
| G1 | No seller read for booking-credit balance or consumption | unavailable (§5.3) | **untracked, candidate issue** |
| G2 | No usage read for seats or locations | unavailable (§5.2) | **untracked, candidate issue** |
| G3 | No dispute, objection or appeal routes, and no reviewer capability | unavailable / absent (§6) | #162, #180 |
| G4 | No seller-owed receivable | unavailable (§5.5) | #177 |
| G5 | No delegated calendar authority (reception) | stated fact (§3.5) | OPEN decision, `V33-DEC-030` |
| G6 | No labelled seller workspace list outside finance | the §2.3 rule | #210 |
| G7 | No `createdAt` on `/v1/me`, no public completed-booking count | absent | #226 |
| G8 | No monthly finance series | absent | #255 |
| G9 | Governance state (`legacy_exempt \| governed`) not readable by the seller | absent | spec 42 §4-a |
| G10 | Reported image not addressable by a moderator | uphold-and-delete disabled | #265 |

G1 and G2 are the only gaps this audit found that have no issue. They are listed for the owner to triage and are **not** created by this design PR.

## 14. Non-goals

No backend route, field, migration or capability. No production frontend. No change to any built screen. No commercial value, rate, fee, schedule, deadline, cutoff, grace, window or allowance. No legal or consent sentence. No provider claim. No dispute, appeal, reception or B2B surface beyond its unavailable or absent state. No new ADR or `V33-DEC` card.
