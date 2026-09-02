# Runbook — secret rotation

## Status

The secret **contract** is enforced in code and tested:
`SECRET_CONTRACT` in `v3/apps/api/src/config/env.validation.ts` names every
secret the application reads and what an attacker gets by learning it, and
production refuses to boot on a placeholder, a too-short value, or one secret
serving two purposes.

The PostgreSQL procedure was exercised against the local development cluster on
2026-09-02: six credentials were rotated, old credentials were rejected over the
SCRAM-authenticated host connection, grants were re-verified, migrations remained
idempotent and health/readiness passed. That proves the local mechanism, not production
operations. Production rotation, provider-key rotation and a zero-downtime hosted drill
remain unexercised and still require a real deployment.

The local credential locations and generation rules are documented separately in
[`LOCAL_SECRETS.md`](LOCAL_SECRETS.md).

---

## Read this first

**Each secret has a different blast radius, and rotating them the same way is
how a rotation becomes an outage.** The table in `SECRET_CONTRACT` is the
authority for what each protects; this runbook is about what happens to live
users when the value changes.

Three shapes:

| Shape | Secrets | Effect of a change |
|---|---|---|
| **Instant invalidation** | `JWT_ACCESS_SECRET` | Every issued access token becomes unverifiable. All sessions drop. |
| **Silent data loss** | `OTP_HMAC_SECRET`, `MEDIA_*_TOKEN_SECRET` | Existing stored hashes and issued tokens can never be verified again. |
| **Connection-scoped** | `DATABASE_URL`, `FINANCIAL_DATABASE_URL`, `MEDIA_S3_*` | Nothing user-visible if the credential is changed on both sides atomically. |

---

## `JWT_ACCESS_SECRET`

**Effect:** every signed-in user is signed out at once.

There is no dual-secret verification path in this codebase. Adding one is the
right way to make this rotation seamless, and it is real work — the guard
verifies with a single secret today.

So this rotation is a deliberate, announced event:

1. Pick a window. Access tokens are 15 minutes; refresh tokens are 30 days and
   are stored server-side, so a customer whose access token dies still holds a
   valid refresh cookie and re-authenticates transparently **provided the
   refresh path works**. Verify that first on a staging deployment.
2. Rotate the platform secret and restart.
3. Watch `beauclick_http_requests_total{route="/api/v1/auth/refresh"}` and the
   4xx rate.

If `MEDIA_UPLOAD_TOKEN_SECRET` / `MEDIA_DOWNLOAD_TOKEN_SECRET` are **unset**,
they fall back to `JWT_ACCESS_SECRET` — so rotating it also invalidates every
outstanding upload grant and download token. Set them explicitly before the
first rotation and this coupling disappears. `SECRET_CONTRACT` records the
fallback; the reuse check deliberately does not fire on it, because absent is
not the same as two variables set to one string.

## `OTP_HMAC_SECRET`

**Effect:** every OTP currently in flight becomes unverifiable.

The stored value is an HMAC and the plaintext is never persisted, so a rotation
cannot be "migrated" — there is nothing to re-hash. Codes expire in 120
seconds.

1. Rotate during a low-traffic window.
2. Accept that anyone mid-login retries. That is the whole cost.

Do **not** try to keep the old secret around for a grace period. Two live OTP
secrets means two valid codes per phone, which is a doubled brute-force
surface for a five-attempt, six-digit code.

## `DATABASE_URL` / `FINANCIAL_DATABASE_URL`

**Effect:** none, if done in the right order.

```bash
psql "$ADMIN_DATABASE_URL" -c "ALTER ROLE beauclick_app PASSWORD '<new>'"
```

Existing connections in the pool are **not** dropped by `ALTER ROLE` — they are
already authenticated. So:

1. Change the password.
2. Update the platform secret.
3. Restart, so the pool reconnects with it.

Between 1 and 3 the running process keeps working and a new connection fails.
Keep that window short, and do not run it against a host that is mid-scale-out.

Afterwards, always:

```bash
DATABASE_URL="$APP_DATABASE_URL" pnpm verify:roles
```

`ALTER ROLE` does not change grants, but this is one command and the failure it
catches is silent.

## `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY`

Provider-specific. The pattern that works everywhere: issue a **second** key,
deploy with it, confirm uploads and protected downloads, then revoke the first.
Never revoke before deploying.

## `METRICS_AUTH_TOKEN`

**Effect:** the scraper stops scraping until it is updated too.

Rotate the scraper's side first if the platform allows two tokens; otherwise
accept a gap in the graphs. Unset, the endpoint answers **404** rather than
serving openly — so a botched rotation loses the dashboard, which is visible,
rather than publishing it, which is not.

## `ERROR_REPORTER_AUTH_VALUE`

**Effect:** error reports are dropped until it is fixed. Errors are still
logged, and `/health/ready` reports `error_reporting` as `simulated`.

Partial configuration is treated as no configuration, deliberately: an endpoint
with no credential would produce a 401 on every report and an operator would be
debugging the reporter during the incident it exists to explain.

## `SMS_HTTP_AUTH_VALUE`

Blocked on `GAP-11` — no vendor selected. When one exists, the same
issue-second-credential-first pattern applies, and the rotation must be
verified with a **real** send, because a logging fallback that succeeds and
transmits nothing is exactly what `deliversExternally` exists to distinguish.

---

## After any rotation

```bash
curl -s "$PUBLIC_API_BASE_URL/health/ready" | jq '.configuration.valid, .dependencies'
```

`configuration.valid` is a bare boolean in production — the reasons are
withheld from a public, unauthenticated endpoint by design. If it is `false`,
read the process logs on the host: `validateEnv` prints every failing rule at
boot, naming variables and never values.
