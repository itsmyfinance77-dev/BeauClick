# ADR-020: Refresh-Token Storage and CSRF Defence

**Status:** Accepted — implemented in Phase 3.
**Date:** 2026-08-21.
**Closes:** the Phase 1/Phase 2 carry-over "refresh token still in memory, a reload signs the user out".

## Context

Phase 1 held both tokens in memory and disclosed the consequence plainly: a page reload signs the user out. It named an httpOnly cookie as the real answer and assigned it to Phase 2. Phase 2 did not do it, and said so rather than quietly dropping it.

The choice Phase 1 actually faced was between two bad options — "signs out on reload" or "a 30-day credential in localStorage" — and it correctly took the first. Phase 3 removes the dilemma.

## Decision

### Storage

| Token | Lifetime | Where | Why there |
|---|---|---|---|
| Access | 15 min | **In memory only** | Never localStorage (an XSS reads it and exfiltrates a credential). Never a cookie — a cookie is sent *ambiently* on every request to the origin, which is exactly what makes CSRF possible. Sent as an explicit `Authorization` header, it cannot ride along on a cross-site request at all. |
| Refresh | 30 days | **httpOnly cookie, `Path=/api/v1/auth`** | The client cannot read it, so an XSS can act *as* the user but cannot steal a credential that outlives the tab. Path-scoped, so it is not attached to any request that does not need it. |

The refresh token is still returned in the login/refresh response body for **non-browser clients** that have no cookie jar. `apps/web` deliberately ignores that field, and its own test asserts the storage module has no `getRefreshToken` at all — the property is structural, not a convention.

### CSRF: Origin validation, with double-submit as a second layer

The first implementation was pure double-submit — a non-httpOnly `bc_csrf` cookie the client reads and echoes in `X-CSRF-Token`. **Driving a real browser proved it cannot work in this topology**, and this is the ADR's most important content:

> The web app runs on one origin and the API on another. The CSRF cookie is set by the API, so it belongs to the API's origin — and `document.cookie` on the web app's origin cannot see it. The browser dutifully *sends* it with the refresh request, but the client can never *read* it to populate the header. After a reload, with the in-memory copy gone, every refresh was rejected 403 and the user was signed out — exactly the behaviour the cookie was introduced to fix.

Double-submit silently assumes a same-origin (or reverse-proxied) deployment. That assumption was never stated and was wrong here.

The replacement:

1. **Origin validation is the primary defence.** `Origin` is set by the browser on every cross-origin request and on state-changing same-origin ones, and page JavaScript cannot forge it — that is the header's entire purpose. A request from `evil.example` carries that origin, is not in the allow-list, and is refused. The allow-list is the same one CORS uses: one source of truth for who may drive this API.
2. **Double-submit is retained where it can work.** If a token *is* supplied it must match, checked **before** the origin so a trusted origin can never excuse a wrong token. This keeps the protection meaningful for a future same-origin/proxied deployment.
3. **With neither an origin nor a token, the request is refused** rather than given the benefit of the doubt.
4. **The body path is not CSRF-checked at all** — a cross-site attacker cannot read the token to put it in a body, so checking there would only break legitimate native clients.

### Rotation, replay, and the benign race

Refresh tokens rotate, and presenting an already-rotated token is treated as a replay. Two problems surfaced in live QA, both real:

**The claim was not atomic.** `rotate()` did a read-then-write, so two simultaneous refreshes both saw `revoked_at IS NULL` and both issued a pair — one refresh token producing **two live sessions**. It is now a single conditional `UPDATE ... WHERE revoked_at IS NULL AND expires_at > now() RETURNING`, the same compare-and-swap discipline the booking slot claim uses: under READ COMMITTED the loser re-evaluates its predicate against the committed row and matches nothing.

**Replay detection could not tell an attack from a race.** Two tabs, or two API calls that 401 at once, both present the same cookie; one wins and the other arrives holding a token that is now old. Revoking the whole chain there signs a legitimate user out — reproduced with the browser's own network log showing `refresh → 200` immediately followed by `refresh → 401`.

The resolution is two-sided:

- **Clients single-flight their refreshes.** One in-flight promise shared by all callers. This is a correctness requirement, not an optimisation.
- **The server applies a 10-second grace window.** A replay *inside* it is denied but leaves the session intact; outside it, the whole chain is revoked. Either way the request gets nothing — the window only decides whether the rest of the session survives. A client race resolves in milliseconds; someone replaying a captured credential is not typically doing so seconds after the legitimate rotation.

## Consequences

- **Positive:** a page reload keeps the session, verified in a real browser, without any long-lived credential being script-readable.
- **Positive:** two genuine concurrency bugs in rotation were found and fixed — one of which (two sessions from one token) predates this phase's cookie work and would have applied to the body path too.
- **Negative:** the grace window is a deliberate, documented softening of replay detection. An attacker replaying within 10 seconds of a legitimate rotation is denied but does not trigger session-wide revocation.
- **Negative:** Origin validation ties CSRF protection to correct CORS configuration. A wildcard or over-broad `CORS_ALLOWED_ORIGINS` now weakens CSRF as well as CORS. This is called out in the operational notes.
- **Risk:** `SameSite=Lax` is the default and is correct when the API and web app share a registrable domain. A deployment putting them on genuinely different sites must set `AUTH_COOKIE_SAMESITE=none` **and** `Secure`, which the config validator enforces by refusing to boot on the invalid combination.

## Alternatives considered

- **Keep both tokens in memory** (Phase 1/2 behaviour). Rejected: the reload sign-out is a real product defect, and the fix does not require the localStorage trade-off that motivated the original choice.
- **Refresh token in localStorage.** Rejected outright — a 30-day credential readable by any script on the page.
- **`SameSite=Strict` and no CSRF token at all.** Attractive, but insufficient alone: `SameSite` treats a same-registrable-domain subdomain as same-site, so a compromised subdomain defeats it. Origin validation covers that case; `SameSite` remains as defence in depth.
- **Proxy the API under the web app's origin** so double-submit works. A legitimate design, and one this decision does not preclude — the double-submit check is retained precisely so that topology would strengthen rather than change the model. Not adopted now because it would make the frontend a required hop for every API consumer, including future native clients.
