# Persona × capability × workspace (#45)

**Baseline:** `master` `2e3da4a`. Sources: `services/identity/src/rbac/capabilities.ts` (role → capability), `services/business/src/entities/staff-role-grant.entity.ts` (scoped roles), `services/business/src/business.controller.ts` (per-handler resolvers), `services/financial/src/finance-workspace.service.ts` (addressable workspaces).

A persona is a **reading** of live facts, never a stored type. One person can match several rows at once, for example a practitioner who is also a finance-read grantee. Every row is re-evaluated per request by the server. The shell only reads it to decide what to offer.

## 1. The facts that define a persona

| Fact | Source | Live? |
|---|---|---|
| Roles and capabilities | `GET /v1/me` → `roles`, `capabilities` (from `identity.user_roles`) | yes, per `/v1/me` read. Privileged capabilities are also re-checked per request by `CapabilityGuard` |
| Owns a professional workspace | `GET /v1/me/provider`; `uq_professionals_owner_id` (at most one) | yes |
| Owns a business workspace | `GET /v1/me/business`; `uq_businesses_owner_id WHERE deleted_at IS NULL` (at most one live) | yes |
| Membership (`manager` \| `staff`, status) | `GET /v1/me/business-staff` | yes |
| Scoped grant `practitioner_chat` / `finance_read` | owner reads `GET …/staff/:staffId/grants`. The grantee sees its **effect** (a chat conversation, or a finance workspace with `accessMode = 'finance_read'`) | yes, re-read per request |

## 2. The matrix

Legend: ✓ reachable · — absent (not offered, and refused by the server) · ◐ reachable with the stated limit · ⊘ unavailable (no contract).

| Persona | Defining facts | Capabilities (from role) | Contexts offered | Finance workspaces (`accessMode`) | Subscription workspaces | Business routes | Chat | Admin |
|---|---|---|---|---|---|---|---|---|
| **Customer** | `roles ⊇ {customer}` | `bc_book_service`, `bc_use_ai_assistant`, `bc_view_own_orders`, `bc_use_chat` | customer, finance (empty list), business (empty) | none → empty state | none | — | ✓ own conversations | — |
| **Solo professional** | + `professional`, owns a profile | + `bc_manage_own_profile`, `bc_manage_own_services`, `bc_view_own_bookings`, `bc_manage_own_availability`, `bc_view_own_finance`, `bc_manage_own_subscription`, `bc_manage_own_collection_policy` | + professional | professional (`owner`) | professional | — | ✓ own customers | — |
| **Business owner** | owns a live business; role `business` granted in the same transaction as the business row (`V33-DEC-021`) | `business` role set (incl. `bc_manage_business_staff`) | + business | business (`owner`), plus professional if also owned | business (+ professional) | ✓ all, including owner-only | ✓ business conversations (owner) | — |
| **Dual owner** | owns both | union | professional **and** business, separately | both, each `owner`, **selection required** | both, by `workspaceType` | ✓ | ✓ | — |
| **Manager** | membership `role = manager`, active | customer set (plus their own role set if they own a profile) | business (member view) | ◐ none unless granted `finance_read` | none for the employer | ◐ read + `PATCH /v1/businesses/:id`, no owner-only routes | ◐ business conversations per seller-access port (`V32-DEC-010`) | — |
| **Reception** | membership `role = staff`, active, no grant | customer set | business (member view) | none | none for the employer | ◐ membership-level reads only | — (no grant) | — |
| **Practitioner** | membership `role = staff` + owns a professional profile | customer + professional sets | professional (own), business (member view) | own professional (`owner`) | own professional | ◐ membership-level reads | ◐ with `practitioner_chat`: **own** booked conversations only (`V33-DEC-033` R2) | — |
| **Finance-read grantee** | a live `finance_read` grant on an active membership | customer set | finance, business (member view) | granting business (`finance_read`), plus their own if owned | none for the granting business | ◐ membership-level reads | as their membership allows | — |
| **Moderator (full)** | role `moderator` | `bc_moderate_verification`, `bc_moderate_reviews`, `bc_moderate_media`, `bc_moderate_chat` | + admin (moderation only) | as their other facts | as their other facts | as their other facts | as their other facts | moderator landing (52), four queues |
| **Moderator (partial)** | a subset of `bc_moderate_*` (for example through a future role; the design must hold for any subset) | the subset | + admin (moderation only) | — | — | — | — | landing with only the held cards |
| **Platform operator** | role `platform_operator` | `bc_manage_platform` | + admin (full) | as their other facts | — | — | — | overview + `bc_manage_platform` destinations. **No** moderation queues, **no** commercial |
| **Administrator** | role `administrator` | `bc_manage_platform`, the four `bc_moderate_*`, `bc_manage_commercial_plans`, `bc_manage_own_profile` | + admin (full) | as their other facts | — | — | — | everything, unchanged |

## 3. Isolation assertions the matrix implies (for implementation tests)

1. Affiliation alone (`manager`/`staff`) never yields a finance workspace or a subscription workspace for the employer (`V33-DEC-020` Ruling 1).
2. `finance_read` yields exactly the granting business's finance workspace, read-only, through the same six workspace-aware routes. It never yields subscriptions, policies, grants, team management or settlement authority (`V33-DEC-030` D4).
3. `practitioner_chat` yields the booked practitioner's **own** conversations only, never another practitioner's in the same business.
4. No moderation capability yields any `bc_manage_platform` or `bc_manage_commercial_plans` surface or read.
5. `platform_operator` yields no moderation queue, no chat content and no commercial surface.
6. A vertical or trait yields nothing (`V33-DEC-030` D1).
7. Every ✓ above is also a server fact. The shell's offering and the server's admission must agree, and where they cannot agree live (`bc_manage_own_subscription` is non-privileged), the server wins and the UI renders the revoked state.
