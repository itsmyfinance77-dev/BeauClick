# BeauClick internal team demo — runbook

**Demo branch only (`codex/demo-2026-09-28`). Never merged to master.** Pinned application source: the
#212 merge `b2477a30de93ccec22233f5c117db653f2b9ece1`; demo-only additions live under `demo/` plus three small,
opt-in, fail-closed demo seams in `v3/` (OTP inbox observer, identity module binding, web demo label).

Audience: **internal team only**, each member with their own synthetic account. Everything is synthetic;
payment, SMS, email and the AI provider are simulated; no money or message leaves this machine.

## What runs where

| Component | Process / container | Bind | Notes |
|---|---|---|---|
| PostgreSQL 16 | `bcdemo-pg` (volume `bcdemo-pg-data`) | 127.0.0.1:55432 | CI-mirror roles, demo-only passwords |
| OpenSearch 2.19.1 | `bcdemo-os` (volume `bcdemo-os-data`) | 127.0.0.1:59200 | own cluster, loopback only |
| API | `node … dist/apps/api/src/main.js` | 127.0.0.1:53199 | compiled artifact; **sandbox runtime** (`NODE_ENV=development`, see below) |
| Web | `next start` | 127.0.0.1:53100 | production build, demo label on every page |
| Inbox (SMS/OTP simulator) | `demo/inbox/main.mjs` | viewer 127.0.0.1:58444 (+10.20.30.6 when activated); ingest 127.0.0.1:58445 only | per-member login, own-only codes |
| Ingress | separate Caddy (`admin off`, no auto-HTTPS, no :80) | 127.0.0.1:58443 (+10.20.30.6 when activated) | one origin: `/api/*` → API, rest → web |

Runtime state, secrets, certificates, logs, backups: `E:\BeauClick-demo\` (outside git; never committed).
Windows Firewall is **off** on this host's Private/Public profiles — that is why every component binds loopback
and only the ingress and inbox viewer may bind the WireGuard address.

## Why the API runs `NODE_ENV=development`

The artifact is a compiled production build. The API process runs as an isolated **sandbox runtime** because two
contracts are production-impossible by design and were not modified: the sandbox payment gateway (disabled under
production, no override) and the demo OTP inbox adapter (refuses to boot under production). Every other
production rule is re-checked by the preflight: it runs the app's own `productionConfigurationErrors()` over the
exact demo environment and refuses to start unless the only findings are the enumerated sandbox divergences.

## Commands (from the worktree root, `E:\BeauClick-worktrees\demo-2026-09-28`)

```text
node demo/scripts/status.mjs                         # what is running, bound where, health
node demo/scripts/start.mjs --profile L              # loopback only (default; also the fallback)
node demo/scripts/start.mjs --profile W --activate-wireguard   # ONLY after the owner approves team access
node demo/scripts/stop.mjs                           # stop everything (containers stopped, data kept)
node demo/scripts/stop.mjs --keep-infra              # stop app processes only
node demo/scripts/backup.mjs --label golden          # DB (product backup library) + media + seed map
node demo/scripts/restore.mjs --backup latest-golden --profile L --yes-restore-demo   # pre-show reset
node demo/verify/otp-signin-smoke.mjs --profile L    # real OTP sign-in + refusal controls
```

- **Pre-show reset = restore the golden backup.** Elapsed-time scenarios (no-show, completions, reviews) were
  produced in real time and cannot be regenerated quickly; the restore brings them back exactly. The restore goes
  into a NEW database, is verified (inventory + structure vs. the manifest), and only then swapped in; the previous
  database is kept as `beauclick_demo_prev_<n>` for rollback. The search index is rebuilt through the
  administrator's own admin routes.
- **Full rebuild from scratch** (only if the golden backup is lost): `init-secrets` → `infra-up` →
  `provision-db` → `start` → `node demo/seed/seed.mjs --profile L` (~1 h; the elapsed stage waits in real time).

## Signing in (team members)

1. Open the app URL from your handout (WireGuard address once activated).
2. Enter your synthetic number; request a code.
3. Open the inbox URL from your handout, sign in with your inbox username/password, and read your code. You see
   only your own account's codes; codes live 3 minutes in memory only.
4. Enter the code. There is no other way in: no dev-login, no shared codes.

Handouts (`E:\BeauClick-demo\secrets\handouts\<member>.txt`) are delivered by the owner, individually, over a
private channel of their choosing, and deleted after the demo. They are never committed, printed or sent by tooling.

## TLS

Private demo PKI v2 (`demo/scripts/ca-v2.mjs`): constrained root → constrained intermediate → leaf. Installing the
root is each viewer's own manual choice (guide in `E:\BeauClick-demo\CA-INSTALL.md`, CurrentUser only). Nothing is
installed automatically, no browser warning is bypassed, and TLS validation is never disabled. The root and
intermediate private keys were destroyed after issuance.

## Owner-approved demo extensions (DEMO-DEC-001; demo branch only)

- **A — acceptance in web checkout.** The provider page loads the server's disclosure for the chosen time; a governed
  seller's terms are shown with an unchecked box and payment stays closed until it is ticked; the exact disclosed
  versions are sent; changed versions require renewed acceptance; booking details show the accepted terms.
- **B — replacement offer after a provider cancellation.** The refund always continues; the offer lets the customer
  book the same service with the same provider as a NEW booking (own terms, current price, own payment — nothing is
  transferred), at most once, or dismiss it. See `decisions/DEMO-DEC-001-…md` for the state machine and lock order.

## Backups used by the pre-show reset

`restore.mjs --backup latest-golden` picks the newest folder labelled `golden` / `golden-<suffix>`. Take the
presentation backup after the final seed with `node demo/scripts/backup.mjs --label golden-final`.

## Known limitations (say them, do not hide them)

- Settlement / settlement series (#255) screens are live but hold no settled data: fund release (#174 / `#43c`) is not
  built, so collected money stays "pending" and nothing is settleable. No settlement is faked.
- #212's "reschedule instead of refund" works only while the refund decision is still pending/manual; the sandbox
  executes refunds immediately, so it is not demonstrable. B is separate and independent of the refund.
- Backend features without a web screen at the baseline (API-ONLY in `FEATURE-MATRIX.md`): seller subscriptions and
  credit purchases, collection-policy assignment, business locations/resources, seller review replies, loyalty
  membership, the customer's order and review lists, settlement schedules / risk classes.
- All commercial values and policy texts are synthetic and not approved; no legal evidence is recorded; the AI
  assistant uses the deterministic sandbox provider and its disclosure copy is pending legal review.
- Throttling is per client IP and every request reaches the API from the ingress: the `refresh` limit (20/min) is
  shared by the whole team behind it — measured in rehearsal before any change.
- TLS: private demo PKI v3; browsers trust it only after a viewer's own manual import (`CA-INSTALL.md`).

## Hard boundaries

No public exposure; no router or firewall change by tooling; no dev-login; no real providers (preflight refuses
provider variables); no real personal data; no commits of secrets or runtime state; synthetic commercial values
and policy copy are labelled as such and are not approved values or legal text.
