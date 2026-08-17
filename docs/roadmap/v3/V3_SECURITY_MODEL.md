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

## 10. What to explicitly NOT do

Named because each was avoided correctly in V2 and is worth stating as an anti-pattern for V3 too:

- Do not let a client supply its own ownership/tenant ID and trust it, even "just for this one convenience endpoint."
- Do not build a second, parallel authorization mechanism for AI/automation surfaces that's weaker than the one used for direct API access — the AI service must go through the exact same session-derived-ownership resolution as every other client.
- Do not treat "local development only" as a real security boundary unless it's also a hard, default-closed code gate.
- Do not let audit logging be an opt-in convention per handler — it must be structurally enforced.
- Do not conflate "can see a resource exists" with "can download/access its content" for privileged/moderator roles.
