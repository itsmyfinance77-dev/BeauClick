# V3 Security Model (draft)

Status: Phase 12/19 output. Every invariant below was independently confirmed — either by reading the actual enforcement code, or by finding and reading an adversarial test that exercises the attack it claims to prevent — across the 10-domain V2.3.0 discovery pass. Where V2's design is sound, this document says so explicitly and states it as a requirement to preserve, not just describe. Where V2's design has a confirmed gap, it's named and cross-referenced to `V3_GAP_REGISTER.md`.

---

## 1. Identity model

**Phone number is the true identity; the account record is infrastructure around it.** V2's `AccountResolver` treats a WP user row as a resolvable identifier for an underlying phone-verified person, not the other way around — new accounts are created from a verified phone, never the reverse. V3's identity-service must preserve this ordering: **OTP-verified phone possession is the root of trust**, and every other credential (session token, email, display name) is derived from or attached to that root, never a substitute for it.

**Canonical phone form**: normalize every accepted input format (local `09…`, international `+98…`/`0098…`/`98…`, Persian/Arabic-Indic digit variants, spaces/dashes/parens) to one canonical E.164-equivalent form before any comparison, storage, or lookup. Validate the true Iranian-mobile shape (`9` + 9 digits after country-code stripping) — reject anything else at the normalization boundary, not deeper in the stack.

**Never silently merge identities on ambiguity.** If phone-based resolution finds more than one plausible existing account candidate, the correct behavior is: record the conflict for human review, and fall through to creating a new account (the safe default) — never guess which existing account is the "right" one. This is a specific, deliberate V2 rule worth stating explicitly because the failure mode of getting it wrong (silently merging two different people's data) is severe and hard to detect after the fact.

---

## 2. OTP / rate limiting

**REQUIRED baseline** (exact V2 numbers are provisional per `GAP-10` — the *shape* of the rules is not):

- Code: 6 digits, generated via a cryptographically secure random source, never predictable.
- **Never store a plaintext code.** Store only `hash_hmac(code, serverSecret)`; compare via constant-time comparison on verify.
- Expiry: a short, fixed window from issuance (V2: 120s).
- Verify-attempt lockout: a small fixed number of wrong-code attempts per issued code before it's dead and a new one must be requested (V2: 5).
- Resend cooldown: a short fixed window before the same phone can request another code (V2: 60s).
- Rate limits on *requesting* a code, independently by phone number and by client IP, over a rolling window (V2: 5/phone/hour, 10/IP/hour) — both dimensions matter; phone-only limiting is bypassable by requesting codes for many numbers from one IP, IP-only limiting is bypassable by rotating IPs.
- **Anti-enumeration, two specific rules**: (a) requesting a code must never reveal whether that phone number already has an account; (b) a verify attempt against an expired code and a verify attempt against a phone that never had a code requested must return the **identical** error — never let a caller distinguish "your code is stale" from "no code was ever requested for this number."
- **Replay prevention**: a code is consumed atomically on first successful verification; a second verify call with the same correct code must fail as if no active code exists.
- **Purpose-scoping**: an OTP issued for one purpose (login, change-phone, confirm-deletion) must not verify against a different purpose, even for the same phone. For sensitive purposes tied to an already-authenticated session (change-phone, confirm-deletion), scope the code additionally to the requesting session's user ID — a code sent while user A is logged in must not be consumable by anyone who merely learns the phone number and the code, even if they're not user A.

---

## 3. Authorization — ownership derivation

**REQUIRED, and the single most consistently-correct pattern found across the entire V2 codebase**: every service must resolve "whose data/resource is this" from the **authenticated session**, never from a client-supplied request parameter. Concretely: `ownerId := resolveOwner(session.userId)`, and any request field that *looks* like it identifies an owner (`provider_id`, `customer_id`, `business_id` in a request body or query string) must be ignored for authorization purposes — at most used as a value to validate against the session-derived owner, never trusted as the owner itself.

This was verified true, not merely designed-to-be-true, in every domain checked:
- Booking, Financial, and Professional-AI all resolve identity via a session→owned-resource lookup, never a request parameter.
- Financial and AI both have **adversarial tests** that forge the relevant parameter (`provider_id`) to another party's real identity and assert zero leakage — this is the bar V3 should hold itself to for every cross-tenant-sensitive endpoint, not just these two.
- CRM note edit/delete requires *dual* ownership: the note belongs to a genuine customer of the caller's own provider, *and* the caller is the original author — preventing same-business staff from editing each other's private notes even when both have otherwise-valid access to the customer record.

**Confirmed gap to fix (`GAP-08`)**: V2 built exactly one shared helper meant to centralize this pattern (`require_owner_or_capability(ownerId, overrideCapability)`) and it went completely unused, because it only accepts a raw owner ID and most real ownership in this domain is *indirect* (a booking's owner is its provider, whose owner is a user — not a direct booking→user relationship). **V3's equivalent primitive must accept an owner-resolver function, not just a raw ID**, so indirect-ownership domains can actually use the shared mechanism instead of each hand-rolling an inline gate. Verify this by literally counting call sites of the new helper during implementation — if it's near zero again, the abstraction is still wrong.

**Error messages must not leak existence.** A resource that doesn't exist and a resource that exists but isn't yours should return the same generic response ("not found or not yours") — never let an error message allow enumeration of which resource IDs are valid.

---

## 4. Multi-tenant / cross-professional isolation

**REQUIRED**, and provable, not just assertable: for every domain where one professional/business must never see another's data (financial receivables, AI conversation content, CRM notes, own-analytics), the isolation boundary needs:

1. Identity resolved server-side only (§3).
2. **Default owner-only visibility, no implicit staff fallback**, for the most sensitive data (financial, AI) — V2 made this an explicit, deliberate deviation from its own more permissive default (which does allow a staff-role fallback for CRM/analytics). V3 should preserve this two-tier default: broad operational data (CRM, own-analytics) may have a staff-access fallback; money and AI-conversation content should not, unless a specific product decision widens it.
3. **An adversarial test that actually forges the cross-tenant parameter**, not just a happy-path ownership test. V2's financial and AI tests do this correctly (seed party B with a distinguishable real value, ask as party A, assert the value never appears anywhere in A's response) — this exact test shape should be a required part of every V3 endpoint that touches tenant-scoped data, not an occasional nice-to-have.

### 4.1 Chat, as implemented — V3.2-B

Chat is the platform's second store of private subject-authored prose, and the first with **two**
people in it. ADR-031 and ADR-032 carry the full model; three properties belong in this section
because they are the isolation ones.

**Eligibility is proven, not asserted, and is re-proven inside the send transaction.** V2 shipped
chat with no eligibility rule at all — `start_or_get` rejected only self-conversation, so any
holder of `bc_send_message` could open a thread against any user id. V3 requires a booking
relationship, and specifically requires it to be provable: a `cancelled` booking qualifies only
when the append-only `booking.booking_history` shows it previously reached `confirmed`, because
`pending` is the one status a stranger can create unilaterally and a `pending`→`cancelled` hold
would otherwise be an eligibility grant anybody could mint.

**The counterparty is immutable.** It is read once from the historical seller-party snapshot on
the booking's order and written onto the conversation. There is no recomputation and no fallback
to current affiliation, so a professional changing salon cannot move an existing customer
conversation to a business that customer never dealt with. A missing snapshot fails closed.

**The adversarial test shape §4 requires is applied here in four forms**, not one: a forged
counterparty has zero effect; a `pending`→`cancelled` booking grants nothing; a fabricated or
missing order triggers no fallback; and changing a professional's affiliation after the fact
moves no conversation. Missing, foreign, and ineligible targets return the one shared
`NotFoundOrNotYoursException`, byte-identically.

**Known, accepted gap to close, not repeat (`GAP-05`)**: V2's isolation for financial data is enforced only at the REST-controller boundary — `LedgerService` itself has no row-level access control independent of which caller reaches it. V3's data-access layer should not rely solely on "only gated controllers ever call this" as its security boundary; enforce isolation as close to the data as the stack reasonably allows (e.g., row-level security at the database, or a mandatory tenant-scoping parameter the query layer refuses to omit).

---

## 5. AI-specific security model

**REQUIRED — this is the concrete architecture that satisfies the release brief's "AI service must never receive unrestricted database access; context must be explicitly authorized" mandate, verified working in V2, not just designed:**

**Two-stage model**:
1. **Authorization stage** (outside the AI provider entirely): resolve the caller's real identity/ownership from session only, exactly as §3.
2. **Curation stage**: a dedicated context-assembly component takes the *already-resolved* owner ID as a required parameter (it never resolves ownership itself) and calls only already-scoped domain read methods (analytics summary, financial summary, campaign summary — never raw SQL) to build a fixed, minimal, pre-aggregated JSON context. Sensitive-but-unnecessary data (V2 example: CRM notes, raw review text — free-text, potentially PII-bearing, no safe-summarization built) is **deliberately excluded from the context entirely**, not merely access-controlled within it.

The AI provider (LLM or rule-based fallback) then only ever sees this pre-curated blob — it has no independent database access and cannot generate or execute arbitrary queries.

**Output-side validation, independent of provider trust**: never persist or render a model's claimed structured output (e.g. "recommend provider #47") without independently re-verifying that entity still exists, is visible, and matches whatever the model claimed about it. A provider adapter is free to be wrong or to hallucinate; the calling code, not the adapter, is the actual trust boundary.

**System-prompt-level constraints** (for any real-LLM provider): explicit, enumerated forbidden actions (no mutating anything — booking, pricing, settlement, CRM; no inventing numbers/IDs/entities not present in the supplied context; no discussing another tenant's data even if the user names them or tries to redirect the conversation) plus a hard length cap and an injection-phrase blocklist checked *before* the provider is ever invoked, not relied upon as the prompt's only defense.

**Same-tenant-only, adversarially verified**: see §4 — this is not optional for AI specifically, since AI is the domain most likely to be asked, directly, in natural language, to reveal another tenant's information ("what about my colleague's numbers?").

### 5.1 As implemented — V3.2-A, and what ADR-030 adds

**ADR-030 amends this section**, turning each rule above into a named threat with a named
control and a named test. Read it alongside this; where they differ in detail, ADR-030 is the
implemented one.

The two-stage model is built as specified, with three things worth recording because they are
stronger than what this section asked for:

- **The curation stage cannot be widened by accident.** The context is not "a fixed, minimal,
  pre-aggregated JSON blob" assembled by remembering what to leave out — it is a closed
  TypeScript type with three keys, assembled field by field, whose key set is asserted against
  a literal. The excluded material has no port that returns it and no field that could hold it.
  A professional's public `bio` is excluded too, which this section did not require: a public
  string authored by one party and fed into a prompt on behalf of another is an injection
  surface with no compensating benefit.
- **The injection blocklist is explicitly a mitigation, not the defence.** It runs before the
  provider is invoked, as required, and it is checked by a spy that the provider was never
  called. But ADR-030 T1 records what this section leaves implicit: a phrase list is defeated
  by paraphrase, and that is what a phrase list is. The defence is that a successful injection
  has nothing to reach. The list is Unicode-normalised (NFKC, zero-width stripped, Persian and
  Arabic letter forms unified, digits folded), because a filter defeated by a ZWNJ is
  decoration — and ZWNJ is how Persian half-spaces are written.
- **Output-side validation is two steps, not one.** Validation proves SHAPE; verification
  proves FACT. A UUID that parses and refers to a suspended professional passes the first and
  fails the second, and only the second is what a customer acts on. Re-verification reads the
  authoritative provider tables, **not** the search projection: the projection is eventually
  consistent, so a professional suspended thirty seconds ago is still in the index, and
  re-verifying there would confirm exactly the record the platform has just decided must not be
  shown.

**System-prompt-level constraints are not relied on at all in this phase**, because there is no
real LLM to instruct. The only registered provider is deterministic and in-process. The
forbidden actions this section enumerates are enforced structurally instead: the provider is
handed no repository, no `EntityManager`, and no service, so there is no collaborator through
which a mutation could be attempted, and the response schema is `strict()` so a provider
returning an `actions` array is rejected outright rather than having the unknown key silently
dropped.

**Two controls this section does not mention, added by `V32-DEC-008` and `V32-DEC-009`:** a
per-user daily cap enforced in PostgreSQL atomically with the message insert (not a
read-then-write, and not the in-memory HTTP throttler, whose effective limit multiplies by
instance count), and the complete absence of any privileged route that can read AI conversation
content.

---

## 6. Provider-abstraction safety (Payment / AI / SMS)

**REQUIRED**, per the shared pattern in `V3_ARCHITECTURE_PLAN.md` §4:

- **Fail-safe-when-unconfigured**: absence of real provider credentials must never error, and must never silently claim success while doing nothing real — it must degrade to a clearly-labeled, honest local implementation (mock SMS that logs instead of sending; a rule-based AI fallback that only narrates real data instead of calling an LLM; a dev-only payment stand-in that's unmistakably not a real payment).
- **Dev-only stand-ins must be hard-gated closed by default in production.** V2's pattern (`environment_type !== 'production'`, defaulting to `'production'` when unset) is exactly right and should be centralized (today it's duplicated ad hoc in two places with no shared helper — fix that duplication in V3, keep the fail-closed default). A "local development only" label in a UI is not a security control; the actual code path must be unreachable in production regardless of configuration mistakes.
- **No credentials invented, no external verification fabricated.** If a real provider integration can't be verified live (no credentials available), the honest state is "unverified," not a claimed pass.

---

## 7. Audit logging

**REQUIRED, and needs structural enforcement, not developer discipline** — this is the clearest lesson from the entire discovery pass: the identical bug (a REST-reachable, capability-gated mutation silently skipping the audit-log call its equivalent admin-UI action made) was independently found and fixed **three times** in V2, across two different plugins, and **one instance is still open** as of the v2.3.0 tag. Developer discipline alone has already demonstrably failed to prevent this three times.

**V3 requirement**: apply the same enforcement shape V2 already uses successfully for authorization (`permission_callback` is *mandatory* — a route without one fails to register, throwing at startup rather than silently shipping an open endpoint) to audit logging. A capability-gated mutation endpoint that doesn't emit an audit record should fail at registration/build time, not ship silently and get caught in a later audit pass.

**Audit log properties to preserve exactly**: append-only (no update/delete method should exist in the writing service at all — V2 enforces this only by omission, which is a real, open gap in itself, see below); every entry captures actor, action type, entity type/id, previous state, new state, reason (where applicable), and timestamp; kept **structurally separate from the analytics event store** (mixing private administrative actions into analytics aggregates either leaks them or forces every analytics query to filter them back out — V2 got this separation right, preserve it).

**Gap to close, not repeat**: V2's audit-log immutability is enforced only by "no mutating method exists in the code," with no database-level lockout (no trigger, no revoked grant). This is the same class of gap as the Financial ledger's append-only guarantee (`GAP-01`) — V3 should close both with the same mechanism (a database role/permission boundary that makes the mutation structurally impossible, not merely absent from the current codebase).

---

## 8. Evidence / protected-download pattern

**REQUIRED for any V3 feature serving a private file** (verification evidence, data-export archives, receipts): V2's pattern, generalized, is correct and should become the standard for every such feature, not re-derived per feature:

- Store outside any publicly-addressable, predictable path.
- The actual access-control check happens **on every single request** for the file (re-verify caller identity + ownership/authorization + any expiry), never only once at upload/generation time.
- The capability to access the file is a **random, unguessable token** (never a sequential/numeric ID, never derived from the original filename) — the token is the actual authorization artifact, not a side detail.
- Content-sniff uploaded file types server-side; never trust a client-supplied MIME type or file extension.
- **A specific real bug to avoid repeating**: a protected-download link built as a bare URL, served to a GET-navigable `<a href>`, can trip a REST framework's own cookie-auth CSRF guard even for the legitimate owner (this happened in V2's export-download feature). The fix — carry an explicit token/nonce in the URL itself for GET-navigated protected downloads, don't rely on ambient cookie auth for navigation-triggered requests — should be a documented pattern in V3's API guidelines, not rediscovered.
- Admins/staff with a general moderation capability should not automatically gain the ability to *download* another user's private files (V2: admins can see privacy-export *status*, never download the file itself) — visibility of metadata and access to raw content are different privilege levels; don't conflate them.

---

## 9. RBAC / capability model

**REQUIRED shape** (exact roles are `V3_ARCHITECTURE_PLAN.md` territory; this section is about the *mechanism*):

- Prefer capabilities over proliferating roles — a small, fixed set of roles (customer, professional, business, staff, moderator, platform-operator, administrator) each holding a set of named capabilities, checked by capability name at every authorization point, not by role name directly. This makes granting a narrow permission (e.g. "can moderate reviews" without "can manage all platform settings") straightforward without inventing a new role.
- **A lower-privilege "platform operator" tier below full administrator should exist and actually be used** — V2 built this (`bc_platform_operator`: read + platform-management capability, nothing else) but it's currently unused by any real account; both real V2 admin accounts hold full Administrator. V3 should default new privileged accounts to the narrowest sufficient tier, not full admin, as a matter of standing practice — not just have the capability exist in code.
- The REST/API layer must do its own ownership/capability checks and must not rely on any implicit "if you can reach this UI surface, you're authorized" assumption from a lower layer (e.g. an admin framework's own page-level gating) — every mutation-capable endpoint re-checks capability independently of how the request arrived.

---

## 9a. RBAC in practice — V3.1 Phase A (2026-08-27)

§9 above states the required *mechanism*. This section records how V3 actually implements
it, because Phase A changed where the data comes from and added one guarantee §9 does not
ask for.

### The data moved; the checks did not

Roles and capabilities live in `identity.roles`, `identity.capabilities`,
`identity.role_capabilities`, and `identity.user_roles`. Every authorization point still
checks a **capability name** through `@RequireCapability` and `CapabilityGuard` — no guard,
controller, or service tests a role string. This is exactly what Phase 1's own docblock
promised would remain true when the tables arrived.

Until Phase A, `identity.users.roles` was written once at account creation and never
again, so `bc_manage_platform` was ungrantable and the entire admin surface was
unreachable by any account the application could produce (`R31-01`).

### The tiers, and what each holds

| Role | Capabilities | Grantable via API? |
|---|---|---|
| `customer` | book, use AI assistant, view own orders | default at account creation |
| `professional` / `business` | own profile, services, availability, bookings, finance | not used — both are answered by row ownership, not by this map |
| `moderator` | moderate verification, moderate reviews | only by a holder of a superset (i.e. `administrator`) |
| `platform_operator` | **manage platform, moderate verification** | yes, by another operator |
| `administrator` | manage platform, moderate verification, moderate reviews, own profile | **never** — bootstrap only |

`platform_operator` holding `bc_moderate_verification` is a deliberate widening over the
Phase 1 static map: reviewing verifications is the operational tier's work, and the
alternative (also granting `moderator`) would hand the first privileged account authority
over a review domain that does not exist. §9's "narrowest sufficient tier", applied.

### The escalation rule

**A caller may only grant a role whose capabilities are a subset of their own.** One rule,
computed from the data, rather than a hand-maintained who-may-grant-what matrix.

`administrator` is additionally never grantable through the application, even by an
administrator — it is reachable only the way the first operator is, through the documented
bootstrap requiring database authority. No self-grant of a privileged role, ever.

### Session invalidation window — stated, not left to inference

Capabilities are baked into the access token at issue time. Therefore:

- **Ordinary capabilities:** a grant or revocation takes effect at the next token issuance
  — login or refresh — so the window is at most one access-token TTL (15 minutes by
  default).
- **Privileged capabilities** (`bc_manage_platform`, `bc_moderate_verification`,
  `bc_moderate_reviews`): **immediate**. `CapabilityGuard` re-reads the role assignment
  from the database on every request to a privileged route, through a port bound by the
  composition root (`libs/auth` may not import a `services/*` package — ADR-011). A revoked
  operator is refused on their next request even holding an unexpired token, verified live:
  `200 → 403 → 200` with the same token, driven only by the database.

The cost is one indexed lookup per privileged request — the admin surface and nothing else.
It fails closed: a verifier that throws denies. Where no verifier is bound, the guard is
exactly as strict as it was before the re-check existed, never weaker.

### The administrative audit log

`admin.admin_audit_log` is owned by `beauclick_admin_audit_owner`, a role the application
never connects as; the application holds **INSERT + SELECT and nothing else** and, not
being the owner, cannot grant itself back UPDATE. The same reasoning ADR-009/ADR-017 apply
to the financial ledger, and proven the same way — `UPDATE` and `DELETE` both return
`permission denied`.

Audit rows commit **inside the mutation's own transaction** wherever that is physically
possible, so an administrative action that cannot be recorded does not happen. Where it is
not possible — a settlement (separate DataSource, ADR-017) or a search reindex (an external
index) — the route must declare `transactional: false` with a stated reason, and the
declaration is required: a privileged mutation carrying neither `@AuditAction` nor
`@AuditExempt` **prevents the application from booting**, naming the offender.

That structural enforcement is the V3 successor to the boot-time check that finally closed
V2's `GAP-02`, where the same bug — a capability-gated admin mutation that skipped its
audit call — was found three separate times across two plugins before being made
impossible rather than merely discouraged.

---

## 10. What to explicitly NOT do

Named because each was avoided correctly in V2 and is worth stating as an anti-pattern for V3 too:

- Do not let a client supply its own ownership/tenant ID and trust it, even "just for this one convenience endpoint."
- Do not build a second, parallel authorization mechanism for AI/automation surfaces that's weaker than the one used for direct API access — the AI service must go through the exact same session-derived-ownership resolution as every other client.
- Do not treat "local development only" as a real security boundary unless it's also a hard, default-closed code gate.
- Do not let audit logging be an opt-in convention per handler — it must be structurally enforced.
- Do not conflate "can see a resource exists" with "can download/access its content" for privileged/moderator roles.

---

## 11. Phase 4 addendum — Business/Seller and Waitlist confirm the model, add one new primitive

§3's ownership-derivation pattern held for both new domains without modification: `BusinessMembershipResolver.roleFor()` and `WaitlistEntryOwnerResolver`/`WaitlistProfessionalResolver` are the identical `session → resolved relationship` shape `BookingPartyResolver` established, re-verified adversarially (cross-business IDOR, forged staff-consent, cross-party financial leak — all proven against real PostgreSQL, not merely designed; see `V3_PHASE4_IMPLEMENTATION.md` §20).

**One new primitive worth naming for future domains with a multi-actor relationship (more than the customer/professional pair booking already had): consent as a state-machine constraint, not a check.** A business invite is never active until the INVITED user's own session moves it there — there is no code path, including the inviting owner's own, that can activate it any other way. This is stronger than a permission check because it is not bypassable by a bug in a permission check: the state simply cannot reach `active` without the real actor's own authenticated call. Recommended as the default shape for any future feature where party A can grant party B something of B's own (access, earnings, data) — a direct write by A should not be structurally possible.

§9's RBAC note is reconfirmed rather than changed: Business's owner/manager/staff tiers are **not** drawn from the platform's `identity.users.roles`/`CAPABILITIES_BY_ROLE` map — they are entirely local to `business_staff`, resolved per-business. This is consistent with `professional` already working the same way (ownership of a row, not a granted role), not a new inconsistency Phase 4 introduced.

## 13. Global rate limiting (PHASE5-02 — RESOLVED)

Rate limiting is now enforced globally by `BeauClickThrottlerGuard`, registered as an `APP_GUARD` in `AppModule`.

**Root cause of the original gap, for the record.** Two defects, and the second is why a naive fix would have failed at boot:

1. `@nestjs/throttler` does **not** auto-register its guard. `ThrottlerModule.forRoot()` only provides `THROTTLER_OPTIONS` and `ThrottlerStorage`. No `ThrottlerGuard` was ever registered — so the module config *and* the three `@Throttle` decorators already present on `request-otp`, `verify-otp` and `refresh` were **inert metadata**. This is worse than absent protection: the source read as though those routes were rate-limited.
2. `ThrottlerModule.forRoot()` is not `@Global` in v6, and it was configured in `IdentityModule`. A root-level `APP_GUARD` could never have resolved its storage — the same DI trap Phase 4 hit with `PRICING_RULES`.

**Identity key.** Authenticated user id when present (`user:<id>`), IP otherwise (`ip:<addr>`), namespaced so the two can never collide. The id comes from `req.user`, populated only from a **cryptographically verified** JWT — never a client-supplied header, body, or query field. The guard is registered **after** `JwtAuthGuard` for exactly this reason: registered before it, `req.user` would always be undefined and every authenticated request would silently fall back to a shared IP bucket. This matters in practice — the stock IP-only tracker makes every user behind one NAT or corporate egress throttle each other.

**`trust proxy` is deliberately OFF**, so Express returns the real socket address and `X-Forwarded-For` is ignored and unspoofable. **If a deployment ever terminates TLS behind a load balancer this becomes a required, security-sensitive change**: without it every request appears to originate from the balancer and shares one bucket; with it set to `true` the header becomes spoofable again and the limit is trivially bypassed by rotating it. It must be enabled with a specific trusted hop count, never `true`.

**Policy.** Five named policies — one registered throttler plus four per-route overrides of it — all environment-overridable so infrastructure can retune without a code change: `default` 120/min, `read` 300/min, `mutation` 30/min, `auth` 100/min, `refresh` 20/min. The `read` figure is derived from a real workload fact rather than guessed — the search page debounces autocomplete at 250ms, so sustained typing legitimately produces ~240 req/min, which is precisely why the old inert 30/min default could not simply be switched on. `auth`/`refresh` carry their pre-existing values and reasoning forward unchanged; `OtpService`'s own 5/phone/hour + 10/IP/hour (§2) remains the real business rule, with the route limit only a coarse DoS backstop above it. **Every number is a provisional engineering default (GAP-10 class), not a business or infrastructure sign-off.**

**Exactly ONE throttler is registered, and that is the only correct shape.** `ThrottlerGuard.canActivate` loops over every configured named throttler and requires all of them to pass. Registering one throttler per policy does **not** give each route its own limit — it applies every policy to every route, making the effective limit their *minimum*. An intermediate version of this work did exactly that, which would have capped search (documented as 300/min) at `refresh`'s 20/min, and every other route with it. Per-route limits therefore come from `@Throttle(policy('read'))` overrides of the single `default` throttler, never from registering more throttlers. The override limits are **functions**, resolved per request, so they read the live environment — constants would be captured at module import, before any test harness could set its own limits.

Two bugs this uncovered, both found by CI rather than review, and both only findable once the guard was actually active:

1. **`@SkipThrottle()` skips only the throttler literally *named* `default`.** Under the intermediate five-throttler design that left `/health` subject to the other four — liveness probes eventually 429ing and healthy instances being pulled from rotation, i.e. the exemption causing the outage it exists to prevent. Moot under the single-throttler design (bare `@SkipThrottle()` is now exactly right), but worth recording: it is a trap for anyone who later adds a second named throttler.
2. **A stale window is not the same as a stale block.** `blockDuration` defaults to `ttl`, so exceeding a limit starts a block *on top of* per-hit decay. A reset test waiting only 1.3× the ttl flaked accordingly.

**Exemptions.** `/health` only — and because it is infrastructure-critical, not because it is frequently called: throttling a liveness probe eventually marks a healthy service unhealthy and removes it from rotation, i.e. a rate limit causing the outage it exists to prevent. Safe because the route takes no input, mutates nothing, and returns a fixed-shape status. The payment callback is **not** exempt but uses the generous `read` policy: callbacks for all customers arrive from the gateway's few IPs and share a bucket, and a false 429 there would mean money moved while the booking stayed unconfirmed. Throttling is not what protects that route — server-to-server verification is. **That policy must be re-derived from a real gateway's actual callback rate and source-IP behaviour when GAP-06b lands.**

**Error contract.** Throws into V3's existing 429 shape (`RATE_LIMITED`, Persian) rather than the library's English `ThrottlerException`. The body carries no retry hint, limit, remaining count, tracker key, or policy name — those would tell an attacker exactly how much budget remains and which bucket they landed in.

**Storage.** In-memory, per process. This is a real limitation: with more than one API instance each holds its own counters, so the effective limit multiplies by instance count. Adequate at current single-instance scale; a shared store (Redis) is the correct fix at multi-instance scale and is a deliberate non-adoption today rather than an oversight.

## 12. Phase 5 addendum — release audit, one real gap found and deliberately not closed

Every ownership/authorization pattern in this document was re-verified against the full real-Postgres suite (342 tests) rather than re-derived — nothing here changed. One genuine gap was found in the platform-wide (not ownership-specific) defenses: `ThrottlerModule` is registered but its guard was never wired to `APP_GUARD`, so no route gets generic per-requester-IP flood protection. Deliberately not fixed in the same pass that found it — see `V3_RELEASE_AUDIT.md` §4 and `V3_GAP_REGISTER.md`'s PHASE5-02 for why a blind fix here risked the very test suite this document's guarantees are proven against, and what closing it safely requires (a test-environment bypass, mirroring `DISABLE_BACKGROUND_SWEEPS`). The security-critical surface this would most matter for — unauthenticated OTP requests — is unaffected: it already has its own dedicated, always-enforced, independently-tested limiter (`OtpService`'s own per-phone/per-IP counters), which this gap does not touch.

## 14. Release-gate addendum (2026-08-23) — payment sandbox production lockout

`v3.0.0` was released under an explicit release-policy exception (**EXC-001**,
`V3_RELEASE_POLICY_EXCEPTIONS.md`) with `GAP-06b` — a real production payment gateway —
still OPEN. That exception rests on a security property this document is the right place
to state as a **standing invariant**, not merely a Phase 5 implementation detail:

**INVARIANT — a payment simulator must never be reachable in production, and no
configuration may make it so.**

`SandboxPaymentProvider.isEnabled()` requires two independent conditions and fails closed:

```
NODE_ENV !== 'production'   AND   PAYMENT_ENVIRONMENT === 'sandbox'
```

`NODE_ENV=production` is an **unconditional hard stop**. The former
`PAYMENT_ALLOW_MOCK_GATEWAY=true` escape hatch was **removed rather than carried forward** —
the V2 precedent is instructive: that version's Cash-on-Delivery stand-in was "local
development only" as *UI text with no mechanism behind it*, which a readiness audit caught.
A simulated bank that one environment variable can switch on in production is exactly the
hazard this gate exists to eliminate, so the gate deliberately has no off switch — the same
reasoning that rejected a `DISABLE_THROTTLING` flag in §13.

Three properties make the invariant hold rather than merely be asserted:

1. **The registry consults `isEnabled()` on every resolution**, so the decision is not
   frozen into a boot-time flag of our own, and it **refuses an unknown provider key**
   rather than falling back to another gateway — a misconfigured
   `PAYMENT_DEFAULT_PROVIDER` cannot silently reroute payments.
2. **The unauthenticated sandbox checkout route re-checks the gate itself.** That route is
   `@Public()` by necessity (a real gateway's page carries no BeauClick session), so it must
   refuse on its own rather than assume an earlier layer did.
3. **The gate is tested against the provider's own logic**, not through `@nestjs/config`'s
   cached boot snapshot — testing it through that cache would assert nothing.
   `payment-security.pg-spec.ts` enumerates every bypass an operator might reach for
   (`PAYMENT_ALLOW_MOCK_GATEWAY=true`, `PAYMENT_ALLOW_SANDBOX=true`,
   `PAYMENT_ENVIRONMENT=sandbox`, `PAYMENT_ENVIRONMENT=production`) and asserts each stays
   shut.

**Consequence, stated plainly:** in production today there are **zero enabled payment
providers**, so checkout fails closed. That is correct — refusal, never a fabricated
success — and it is what makes releasing with GAP-06b open a defensible decision rather
than a reckless one.

**If this invariant is ever weakened, EXC-001 must be re-decided.** The exception is
explicitly conditioned on it (`V3_RELEASE_POLICY_EXCEPTIONS.md` § "Review condition"). This
property is load-bearing for a release decision, not just for the payment domain.


---

## 15. Global QA security addendum (2026-08-24, post-v3.0.0)

Findings from the global QA + UI/UX pass that change this document. Full narrative in
`V3_GLOBAL_QA_REPORT.md`.

### 15.1 Input canonicalization must happen BEFORE the validator, not after it

§1 requires every phone number to be canonicalized to `+98XXXXXXXXX` before comparison,
storage, or lookup, and `canonicalizePhone()` implements that — including Persian (۰–۹)
and Arabic-Indic (٠–٩) digit folding.

**That folding was unreachable over HTTP for the whole of V3.** The `@Matches`
validator on `RequestOtpDto`/`VerifyOtpDto` runs *first*, and `\d` in a JavaScript regex
is ASCII-only, so a Persian-digit phone number was rejected as malformed before the
canonicalizer ever saw it. The security property was never violated — but the layer
implementing it was dead code on the request path, which is its own kind of finding: a
guarantee that reads as satisfied in the file that implements it while an adjacent layer
silently negates it.

**Rule this establishes, and which now holds:** canonicalization is part of *accepting*
input, not part of processing it. Any DTO whose validator constrains a canonicalizable
field must apply the canonical transform in a `@Transform` before validation. Both auth
DTOs now do, using `normalizeDigits` from `@beauclick/persian-utils` — the same utility
`SearchProvidersDto` already used for the same reason.

The OTP **code** had the same shape and a materially worse consequence. `OtpService`
HMACs the code verbatim, so `HMAC('۱۲۳۴۵۶') ≠ HMAC('123456')`: a correct code retyped in
Persian digits was scored as wrong **and consumed one of the five attempts** §2 allots,
reaching irreversible lockout in five tries. Because §2 also (correctly) requires every
failure mode to return an identical generic error, the user had no way to discover why.
Anti-enumeration and lockout are both still enforced exactly as specified; the code is
now folded before either applies.

### 15.2 Amount integrity requires a unit, not just a number (§ payment)

The payment verification path compared the gateway's reported amount with the intent's
amount as **bare numbers**. `VerifyPaymentResult` carried no currency field, so nothing
but a field *name* (`paidAmountToman`) asserted that both sides meant the same unit.

This is not a sandbox concern — it is a **production adapter** concern, and therefore
part of `GAP-06b`'s risk surface. Iranian gateway APIs commonly denominate in **rials**,
and 1 toman = 10 rials. An adapter that passed the gateway's own figure straight into
`paidAmountToman` would settle a 200,000-toman order for 20,000 tomans of real money,
and **every existing amount-tampering test would still have passed**, because both sides
are just numbers. The sandbox cannot surface this class of defect: it is IRT by
construction.

**The contract now has a third mandatory rule**, alongside "verify() must talk to the
gateway" and "verify() must report the captured amount":

> **3. `verify()` must state the CURRENCY/unit of the amount it reports**, and it must
> be the platform unit.

Enforcement: verification requires `paidCurrency` to be **present and equal** to the
intent's currency. An adapter that omits it **fails closed** rather than being assumed
to mean tomans. The audit log records expected and reported currency separately, so
"wrong number" and "wrong unit" are distinguishable incidents. Covered by three cases in
`payment-security.pg-spec.ts`, including an honest-path control so the check cannot pass
by refusing everything. **Those cases require CI's PostgreSQL and have not yet executed.**

### 15.3 A frontend route is not covered by a backend feature gate

The sandbox checkout page (`/sandbox-gateway`) took its return address from a query
parameter and navigated to it unvalidated — an **open redirect** that rendered a
plausible BeauClick payment screen and then delivered the visitor to an attacker's site,
with BeauClick's own domain in the address bar throughout.

The reasoning error worth recording is not the missing validation; it is the assumption
behind it. `SandboxPaymentProvider.isEnabled()` fails closed in production, and that gate
is genuinely sound — but it gates the payment **provider**, an API-side concern.
`/sandbox-gateway` is a statically-prerendered Next.js route that renders in **any**
environment regardless of what the API decides, and its redirect fires before any API
response is even consulted. A production deployment with zero enabled payment providers
still serves this page.

**Rule:** a frontend route may not treat a backend capability gate as its own access
control. Where a page performs a security-relevant action, it must validate
independently. The page now requires the callback's origin to match the configured API
exactly — the only legitimate destination, since the real value is built server-side in
`SandboxPaymentProvider.initiate()`. `apps/web/test/sandbox-callback.spec.ts` pins it,
including lookalike-host, protocol-relative, and non-HTTP-scheme cases.

A second defect on the same page: `/decide` answers **HTTP 200** with
`{ accepted: false }` for every refusal it knows about — disabled sandbox, unrecognised
decision, and an already-decided transaction (its compare-and-swap losing). The page
checked only `response.ok` and redirected to the payment-complete leg regardless.
Reachable by double-clicking. The response body is now honoured.

### 15.4 Authorization re-verification — no new findings

Every route taking a resource identifier was enumerated and checked for an ownership
boundary. Routes without `@ResolveOwner` were individually verified to enforce ownership
in their own data access rather than assumed safe:

| Route | Boundary | Verdict |
|---|---|---|
| `GET /v1/me/finance/orders/:orderId/ledger` | `myLedgerForOrder` filters entries to the caller's own party | Sound. A foreign `orderId` yields an empty list, never another party's rows. |
| `DELETE /v1/me/availability/slots/:slotId` | `DELETE ... WHERE id AND professional_id AND status='open'` | Sound. Cross-professional deletion impossible. |
| `PATCH /v1/me/journey/goals/:id` | `WHERE id AND user_id`, plus compare-and-swap on status | Sound. |
| `POST /v1/me/notifications/:id/read` | `WHERE id AND user_id AND read_at IS NULL` | Sound. (An unrelated correctness bug in the *fallback* branch was fixed — it paged one row, so only the newest notification could be recognised as owned, returning a wrong 404 for older already-read ones.) |
| `POST /v1/payments/intents/:intentId/initiate` | `intent.customerId !== user.userId` → null redirect | Sound. An intent id alone is never authority to pay, and the refusal shape is identical to a nonexistent intent. |

`MyFinanceController` continues to take **no** party argument on any route, keeping §3's
"unrepresentable rather than merely checked" property intact. Admin cross-party surfaces
remain a separate controller and service behind `bc_manage_platform`.

### 15.5 Unchanged and re-confirmed

OTP storage/compare/consume semantics, anti-enumeration, phone+IP rate limits, refresh
rotation with replay revocation, httpOnly refresh cookie with Origin-based CSRF on the
cookie path only, `trust proxy` off, single-flight client refresh, global throttling
(`PHASE5-02`), and the sandbox production gate with no override — all re-read this pass
and all still hold as documented.

**Still disclosed, unchanged:** throttler storage is in-memory per process, so at
multi-instance scale the effective limit multiplies by instance count; RBAC is
code-based; audit logging is structured-logger-based rather than DB-persisted.

---

## 16. V3.1 Phase E addendum (2026-08-28) — privacy, the session claim, and the SMS provider

### 16.1 Privacy: authorization by construction, not by check

**There is no user id anywhere in `PrivacyController`.** All four self-service routes derive
the subject from `@CurrentUser()`, so "export somebody else's data" and "delete somebody
else's account" are requests this API cannot express — the same construction `/v1/me` uses,
and the strongest available form of §3's rule: there is nothing to forge because there is no
parameter.

Request ids appear in paths, and every lookup is scoped by **both** id and subject. Another
user's request id, a nonexistent one, an export that is not generated yet, and one that has
expired all produce a **byte-identical** 404 (`NOT_FOUND_OR_NOT_YOURS`) — asserted by
comparing whole response bodies, not by reading the code. A caller who could distinguish them
would have an oracle over other people's privacy requests.

### 16.2 The export payload is structurally unreachable by an operator

Phase E's requirement is unqualified: *no admin route may ever download another user's export
file.* Rather than enforce it with a `SELECT` somebody must remember not to write, the request
row and the document live in **different tables**. `GET /v1/admin/privacy/requests` reads
`privacy.data_requests`; the payload is not on the row it read.

Two related properties, both asserted from an authenticated `platform_operator` session
rather than only from an anonymous one — because the operator is the caller who could
plausibly have been granted the ability:

- an operator is refused another user's export download;
- **there is no administrative cancel route for an erasure at all.** An operator who can
  cancel a deletion can silently keep an account its owner asked to be rid of. When a request
  is stuck, a `failed` status plus a stable `failureCode` is what an operator acts on.

The document is stored in PostgreSQL rather than object storage on purpose: a presigned URL to
a complete personal-data export is a bearer credential that survives being forwarded, logged
by a proxy, or left in browser history. An authenticated route re-verifies the session on
every byte delivered. On expiry the payload row is **destroyed**, not merely made unreachable
— and the DELETE commits before the status flip, in one transaction, so a crash between them
cannot leave an `expired` request beside a live copy of somebody's data.

### 16.3 What an export deliberately withholds

Being the subject's own data does not make everything about them safe to hand over in one
file:

| Withheld | Why |
|---|---|
| `identity.refresh_tokens.token_hash` | A credential. The subject gains nothing; anyone who obtains the document gains hashes to attack offline |
| `payment.payment_attempts.provider_response` | A vendor diagnostic blob whose shape differs per provider and which routinely carries a masked card number or a third party's account reference |
| `media.objects.storage_key` | The object store's key layout, published to whoever obtains the file |
| `admin.admin_audit_log`, in full | Almost every row about a subject records what an OPERATOR did to them, and the snapshots name the operator or quote a moderator's private reasoning. Handing somebody the internal reasoning behind a takedown, including who triggered it, is how a moderation system becomes a retaliation tool |
| Another party's side of a shared record | A professional's export does not contain the list of every customer who has booked them |

### 16.4 Erasure is bounded by the database, not only by policy

`financial.*` is retained by legal obligation — and the application role holds no `UPDATE` and
no `DELETE` there (ADR-017), so an erasure that tried would fail. `admin.admin_audit_log` is
append-only under its own owner role for the same reason: an erasure able to touch it would be
a way for an operator to launder their own history.

The compliance record (`privacy.data_requests`) survives the erasure it proves happened, so it
carries **counts and timestamps only, never content** — a test serializes the row after
execution and asserts the erased phone number is not in it.

Erasure is also **atomic across every module**: one transaction on the application DataSource
covers all sixteen contracts, the request row, the audit row, and the event. A subject whose
identity was destroyed but whose reviews still carried their text would be both un-notifiable
and un-retryable, because nothing would record how far it got.

### 16.5 The `sid` claim (`QA-20`) — what it is and what it is not

Every access token now carries `sid`: **the refresh row's UUID, never the refresh token.** The
token itself is stored only as a SHA-256 hash and is not recoverable from anything the client
holds. Knowing the id lets a bearer identify which of their own sessions is speaking; it does
not let them use it, and every route acting on a session id still resolves ownership from
`userId` — a test revokes across users to prove it.

The claim is **optional**, and that is load-bearing: tokens minted before it existed stay valid
for their full 15 minutes across a deploy, so requiring it would 401 every signed-in user.
Those report `current: false`, which is the honest answer rather than a guess.

### 16.6 `QA-19`'s new fields are not an enumeration oracle

`POST /v1/auth/request-otp` gains `cooldownRemaining` and `expiresInSeconds`. Both are policy
constants, identical for every caller, so neither varies with account existence — asserted by
comparing the **whole response body** for a phone with an account against one without.

A refusal inside the resend window carries `retryAfterSeconds`; a refusal from the **hourly**
window deliberately carries none, because when that window resets depends on when each of up
to five earlier requests landed. A plausible number there would have a client count down to a
moment that still fails, which is worse than no number because it looks reliable.

### 16.7 SMS provider (`GAP-11`) — §6's rule, extended

§6's provider-abstraction safety rule now has a third instance. `SmsChannel` reports
`providerVerified` **derived** from the configured provider's `deliversExternally` rather than
declared, so the two cannot drift: a deployment that has wired a real gateway stops being
described on the health surface as one that has not, and an unconfigured one cannot claim it
is sending.

Three security properties of `HttpSmsProvider`, all exercised against a real HTTP server:

- **https only, enforced at configuration time.** The request body carries a one-time login
  code and a phone number; a plaintext endpoint hands both to anyone on the path.
- **Partial configuration is treated as NO configuration.** An endpoint with no credential
  would 401 every OTP and fill the dead-letter queue with unauthenticated attempts while the
  operator debugged delivery instead of reading "no provider configured".
- **A gateway's error body never leaves the provider.** Gateways routinely quote the
  recipient's number back in an error string, which would otherwise flow into the notification
  row, the `NotificationFailed` event, and every log line downstream. Only a stable code
  escapes, and a test asserts the number is absent from the outcome.

**GAP-11 remains open.** No vendor is selected and no live send has occurred; what closed is
the code side.

### 16.8 Unchanged and re-confirmed

Everything in §15.5 was re-read this pass and still holds. The one change to token shape is
§16.5's additive optional claim; no existing claim was removed or retyped, and no guard's
behaviour changed.

**Still disclosed, unchanged:** throttler storage is in-memory per process (`THROTTLE-STORE`),
so at multi-instance scale the effective limit multiplies by instance count.
