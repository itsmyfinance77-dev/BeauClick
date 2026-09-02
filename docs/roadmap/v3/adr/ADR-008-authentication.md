# ADR-008: Authentication & Authorization

**Status:** Accepted — implemented and subsequently extended by the capability and privacy work.
**Date:** 2026-08-19.

## Context

V2's authorization *design* is confirmed correct pervasively — `V3_SECURITY_MODEL.md` §3/§4 verified (not merely claimed) that ownership is always session-derived, never trusted from a client-supplied parameter, across booking, financial, B2B, verification, and professional-AI, including two domains with adversarial tests proving forged parameters have zero effect. The one real, confirmed gap: `require_owner_or_capability()`, V2's own shared ownership helper, is dead code — it only accepts a raw owner ID, and most real ownership in this domain is *indirect* (booking→provider→user), so every domain reimplemented its own inline gate instead (`GAP-08`).

V2's *authentication mechanism*, however, is genuinely primitive: phone/OTP login exists (a real, well-specified, adversarially-reasoned-about system per `V3_SECURITY_MODEL.md` §1-2) but session management itself is plain WordPress cookie auth — **no token infrastructure exists at all** (`V3_MIGRATION_MATRIX.md` Authentication section: "REIMPLEMENT — no token infrastructure exists in V2 at all").

## Decision

**Identity-service owns phone-as-root-of-trust OTP authentication (business rules extracted near-verbatim from V2) plus a genuinely new JWT/refresh-token session mechanism (net-new, no V2 precedent to port).**

Specifically:
1. **Phone-as-identity, never-silently-merge**: preserve V2's exact identity-resolution invariant — OTP-verified phone possession is the root of trust; on ambiguous multi-account resolution, record the conflict and create a new account rather than guessing (`V3_SECURITY_MODEL.md` §1).
2. **OTP rules preserved as extracted business rules, not the numeric constants**: 6-digit HMAC-hashed code, constant-time compare, expiry/lockout/cooldown windows, dual phone+IP rate limiting, anti-enumeration (identical error for "expired" vs. "never requested"), atomic single-use consumption, purpose-scoping (a code for one purpose never verifies for another) — all REQUIRED per `V3_SECURITY_MODEL.md` §2. The exact numeric values (120s expiry, 5 attempts, 60s cooldown, etc.) are explicitly `NEEDS_BUSINESS_DECISION` (`GAP-10`) — carry the *shape* forward, not the numbers, without a fresh sign-off.
3. **Real JWT/refresh-token session mechanics — net new.** No V2 code to port; the contract this new mechanism must satisfy is the authorization *rules* in §4/§5 below, not any existing token code (there is none).
4. **The ownership-resolver primitive must accept an owner-resolver function, not just a raw ID** — the concrete fix for `GAP-08`: `resolveOwner(session.userId) → ownerId`, composable for indirect ownership (booking→provider→user, quote→business-account, AI conversation→provider), so every domain can actually use the shared primitive instead of reimplementing it a 5th time. Verify success by literally counting real call sites during implementation — near-zero again means the abstraction is still wrong (`V3_SECURITY_MODEL.md` §3).
5. **RBAC**: capability-based checks (not role-string checks) at every authorization point, preserving V2's existing role/capability set as extracted data, including the currently-unused-but-correct `bc_platform_operator` narrower-tier pattern — V3 should default new privileged accounts to it rather than full admin, as standing practice (`V3_SECURITY_MODEL.md` §9).

## Consequences

- **Positive:** the authorization *design* — the hard, easy-to-get-wrong part — is proven and simply carries forward as a contract; only the token *mechanism* (comparatively well-understood, off-the-shelf JWT/refresh patterns) is genuinely new. This is a favorable risk profile: the novel work is the well-trodden part, the hard-won part is already validated.
- **Negative:** a real token-revocation/rotation strategy, session-fixation defenses, and refresh-token storage are all net-new operational surface V2 never had to operate.
- **Risk:** the ownership-resolver fix (#4) must be verified structurally, not just designed correctly — V2's own analogous helper was *designed* well and still went unused; this is a documented recurrence risk, not a hypothetical one.

## Alternatives considered

- **Keep cookie+nonce same-origin auth** (V2's current mechanism, minus WordPress). Rejected — `ARCHITECTURE_PROPOSAL.md` §28 open question #6 already flagged that a native mobile app would need cross-origin token auth "sooner rather than later," and V3's own SSR/SPA frontend split (ADR for frontend strategy) plus a genuinely separate backend argues for real tokens now rather than retrofitting later.
