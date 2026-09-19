# Screen 46 — amendment: per-state funds (`#43a`, #185)

**Amends** `docs/design/screens/46_FINANCE_WORKSPACE.md`. This is **not** a sibling screen: it adds
one section to screen 46 and changes nothing else in it.
**Binding:** ADR-052 §14 and §16.
**Prototype:** `Prototype - Finance Funds States.dc.html` (§E1–E4).
**Backend:** implemented. **Frontend: designed, not implemented.**

## A-1. The route

`GET /api/v1/me/finance/:workspaceRef/funds` — the same workspace-addressed pattern as the five
routes already listed in §2 of screen 46, with the same `Cache-Control: private, no-store` and the
same authority re-read per request. No new route is designed and no existing route changes.

The reader may be the owner **or** a `finance_read` grantee. They see byte-for-byte the same
figures; there is no richer owner view, and no identifier of any party appears in this section.

## A-2. Twelve fields, in two groups

**Seller-side (nine).** `pending`, `disputed`, `available`, `reserve`, `settled`, `refunded`,
`collected`, `platformAdvance`, `recoveredIn`.

**Platform-side (three), kept visibly apart.** `platformEarned`, `providerFee`, `recoveryOut`.

| Field | Label | The question it answers |
|---|---|---|
| `pending` | در انتظار | Collected, not yet moved to any later state |
| `disputed` | درگیرِ اختلاف | Held pending the resolution of a dispute |
| `available` | قابلِ تسویه | Ready to enter a settlement — **not** a promise of when |
| `reserve` | ذخیره | Held by rule; the UI never states a reserve percentage |
| `settled` | تسویه‌شده | Left this ledger and reached the seller |
| `refunded` | بازگردانده‌شده | Returned to the customer |
| `collected` | وصول‌شده | What was actually taken from the customer |
| `platformAdvance` | پیش‌دادهٔ سکو | What the platform advanced before collection |
| `recoveredIn` | بازیافتِ واردشده | What returned to this workspace against that advance |
| `platformEarned` | درآمدِ سکو | Platform money |
| `providerFee` | کارمزدِ درگاه | Platform money |
| `recoveryOut` | بازیافتِ خارج‌شده | Platform money — the platform-side counterpart of `recoveredIn` |

## A-3. The rule the layout enforces

- **No total.** No figure is rendered that sums across the seller/platform boundary. No «موجودی»,
  no "your balance", no single summary card. Nor is a total computed *within* the seller group: the
  nine are states, not shares of one whole.
- The platform-side three sit inside their own bounded block with their own heading stating whose
  money they are, marked by **text and border treatment**, not colour alone.
- The three legacy figures (`receivableNetToman`, `settledToman`, `outstandingToman`) stay exactly
  where they are today, under their own heading, with one sentence stating that the two groups
  answer different questions and do not add up. No ratio, delta or reconciliation between regimes is
  shown.

## A-4. Invented nowhere in this section

Settlement date or cadence, "7 working days", payout minimum, reserve percentage, risk class,
projected payout, fee breakdown per order, any commission figure stated as policy, any party
identifier. The server supplies none of these.

## A-5. States

| # | State | Where | Note |
|---|---|---|---|
| 1 | Populated, mixed regimes | §E2 | Legacy trio above, twelve below, no arithmetic between them |
| 2 | All twelve zero | §E3 | **Correct answer, not an empty state and not an error.** Cards stay, zeros render as zeros, one explanatory sentence, no call to action |
| 3 | Loading | §E3 | Skeleton with `aria-busy`; no stale figure beneath it; previous workspace's figures cleared before the next renders |
| 4 | Read failure | §E3 | `role="alert"`, scoped to this section only, retry offered |
| 5 | Access refused / revoked | screen 46 §5 | Unchanged: one neutral message, **no retry** |
| 6 | `finance_read` reader | §E2 | Identical projection; read-only status stated; no disabled write controls |
| 7 | Mobile 390 | §E4 | Labelled card rows, amount column aligned across cards; no horizontal table |

## A-6. Accessibility and cache

Real `<table>` with `<caption>` for the field reference; tabular numerals with aligned amounts;
`dir="ltr"` isolation on every field name and Latin run; ≥44px targets; status by text and shape.
The six client-side cache rules in screen 46 §6 apply unchanged to this response, and the design
promises no offline or stale-while-revalidate behaviour.

Requires testing at implementation: live-region announcement when the workspace changes, screen
reader RTL order across the two groups, measured contrast on the platform-side block, real-device
target size. **No WCAG 2.1 AA conformance is claimed from a static prototype.**

---

## Reviewer corrections — 2026-09-20 (BeauClick PM session)

Checked field by field against `financial.controller.ts`'s `toFundsResponse` and
`FinanceWorkspaceService.fundsFor`. The twelve wire names in §A-2 are **exact**. Two corrections:

**R1 — the boundary has three sides, not two.** §A-2 puts `collected`, `platformAdvance` and
`recoveredIn` in the seller group. The service's own contract separates them as a **third**
category: `pending`/`disputed`/`available`/`reserve`/`settled`/`refunded` are this workspace's
money; `platformEarned`/`providerFee`/`recoveryOut` are the platform's; `collected`/
`platformAdvance`/`recoveredIn` are **custody and cash-position facts (ADR-052 §12's M1), not a
payable figure**. Rendered inside the seller group, `collected` reads as money owed — the precise
misreading §A-3's "no total" rule exists to prevent. Implement as **three bounded blocks**, the
third headed as facts about this workspace's orders rather than its balance.

**R2 — nine of the twelve are structurally zero today.** `#43a` posts only `collection` and
`refund` journals, so only `pending`, `collected` and `refunded` can ever be non-zero until
`#43b`–`#43g` land, all of which are `gate:external`. §A-5's "all twelve zero" state is therefore
not an edge case but close to the normal reading, and nine permanently-zero cards are a real
legibility problem the design does not address. Decide at implementation whether the reserved nine
render at all before their journals exist.

**R3 — the response carries a thirteenth field**, `currency: 'IRT'`, not listed in §A-2. Not a
defect; noted so the implementation does not treat it as unexpected.
