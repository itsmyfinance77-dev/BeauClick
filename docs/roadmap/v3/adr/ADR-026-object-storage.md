# ADR-026: Object Storage as a Driver Behind a Port, with Two Access Classes

**Status:** Accepted — implemented in V3.1 Phase C.
**Date:** 2026-08-28.
**Relates to:** ADR-006 (payment provider abstraction), ADR-011 (repository architecture), ADR-013 (infrastructure strategy), `V3_SECURITY_MODEL.md` §8 (protected downloads).
**Closes:** `R31-03` — "no file upload or object storage capability exists anywhere in `v3/`", open since the V3.1 gap reconciliation and originally a Phase 1 deliverable that was never built.
**Does not close:** the hosting/region decision (`V3.1_PRODUCT_ROADMAP.md` §12 #1). See "What is still open" below.

## Context

A beauty marketplace with no images is the largest single product gap in V3, and it is not a UI gap: a repo-wide search of `v3/` for `S3`, `multer`, `presign`, and `upload` returned zero matches outside `node_modules`. Portfolio work, professional avatars, and verification evidence were all blocked on infrastructure nobody had built.

Two facts shaped the decision and pull in opposite directions.

**One.** `V3_INFRASTRUCTURE_PLAN.md` §5 already fixes the architecture: "S3-compatible, Iran-reachable provider (ArvanCloud/Liara-class)". What it does not do — and what is downstream of a business decision that has now slipped past three releases — is name a vendor.

**Two.** The three things that need storing have genuinely different access requirements. Portfolio work is meant to be seen by strangers; a scan of somebody's national identity card, submitted so a moderator can verify them, must never be publicly addressable — including after a backup restore.

## Decision

### 1. A driver behind a port, exactly as ADR-006 does for payment

`ObjectStorageDriver` is an interface with two implementations and a single boot-time binding. This is not a new pattern — it is the third instance of one this codebase has already proved twice (`PaymentProvider`, `NotificationChannelPort`), reused deliberately rather than reinvented.

The consequence that matters: **selecting a vendor is five environment variables, not a code change.** The hosting decision produces `MEDIA_S3_ENDPOINT`, `MEDIA_S3_BUCKET`, a credential pair, and a region. Nothing in `services/`, no controller, and no migration is touched.

```
MediaService  ──consults──>  MEDIA_POLICY (purpose -> access class, caps, quota)
     │
     └──delegates bytes to──>  ObjectStorageDriver
                                   ├── LocalObjectStorageDriver   durable: false
                                   └── S3ObjectStorageDriver      durable: true
```

`durable` is on the port, reported by `GET /health`, for the same reason `NotificationChannelPort.providerVerified` exists: a driver writing to one container's own disk must never be indistinguishable from one writing to real object storage. V2 shipped a "local development only" payment stand-in whose production-safety was a sentence in the UI with no mechanism behind it, and Phase 2 found it still reachable.

`MediaModule` refuses to bind the local driver when `NODE_ENV=production` unless `MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION=true` is set — the same two-condition shape the payment sandbox gate uses.

### 2. Presigned direct upload, and the three-step lifecycle that follows from it

The browser sends bytes to the object store, not through the API. An API process that proxies 8 MB uploads has its memory and connection budget set by its slowest mobile client.

That design has one unavoidable consequence — **the API never sees the request body** — and everything else follows from it:

```
1. POST /v1/media/upload-url   quota, caps, a key nobody can guess, a `pending` row,
                               and a target scoped to that ONE key with an expiry
2. PUT  <target>               the client sends bytes; the API is not involved
                               (except on the local driver, where the target points back
                               at a signed-token route on this API)
3. POST /v1/media/:id/finalize the object is read BACK, sniffed, measured, and only then
                               marked `stored`
```

**Every content rule is enforced at step 3**, because step 3 is the first moment the platform can observe truth rather than a claim. A validation performed at step 1 would be validating a promise. Nothing in the product may reference an object that is not `stored`.

### 3. Two access classes, one storage layer

`MEDIA_POLICY` maps each purpose to `public` or `protected`, and the class is **denormalized onto the object row at creation** so a later policy edit cannot retroactively reclassify objects that already exist.

| | `public` | `protected` |
|---|---|---|
| purposes | portfolio, avatar, cover | verification evidence |
| addressable | yes, permanently, cacheable as immutable | never |
| read path | driver's `publicUrl()` | `GET /v1/media/:id/content?token=…` |
| authorization | none — that is the point | re-checked against live data on **every** request |

The protected path implements `V3_SECURITY_MODEL.md` §8 point by point: the token is the authorization artifact and is unguessable by construction (an HMAC over media id + viewer + expiry, never a sequential id); it is carried **in the URL**, because §8 records the real V2 bug where a GET-navigated protected download tripped the framework's own cookie CSRF guard for the legitimate owner; and it is **not sufficient on its own** — the viewer named in the token is re-authorized from the database on every request, so a moderator whose capability was revoked a minute ago cannot open a document with a link minted an hour ago.

### 4. Content is identified by its bytes, and measured

`probeImage` parses PNG, JPEG, and WebP headers in pure TypeScript and returns the format and intrinsic dimensions, or `null`. Anything else — SVG most pointedly, which is an executable document and a stored-XSS vector when served from an origin holding a session — is refused regardless of what the client declared.

The dimensions are not metadata for its own sake. Phase C's one measurable Definition-of-Done item is "renders with zero layout shift", and a browser cannot reserve space for an image whose aspect ratio it learns only when the bytes arrive.

**No image library.** `sharp` and every libvips/ImageMagick binding is a native, platform-specific binary, and it would be pulled in to answer two questions that are answerable from the file header in under two hundred lines. Decoding, resizing, and re-encoding are a different problem — see "What is deliberately not here".

### 5. `libs/media`, not `services/media`

Media is infrastructure, not a bounded context. It has no business rules of its own: ownership and meaning always belong to the referencing domain (`provider` today, privacy exports in Phase E). The precedent is exact — `libs/audit` owns the `admin` schema, has an entity and a service, and is injected directly into `provider`'s `VerificationService`.

Modelling it as a domain would have required a composition-root port for every reference, adding indirection without adding isolation: media has no independent deployability story, and `provider` must transact with it (attaching a portfolio item and claiming its media object are one transaction or they are a leak).

## Consequences

- **Positive:** `R31-03` closes, and with it the prerequisite for `GAP-23` (portfolio), `IMAGERY`, and `R31-02`'s deferred evidence upload — three items that had been blocked on infrastructure for the whole of V3.
- **Positive:** the vendor decision is now genuinely deferrable. Nothing about it changes code.
- **Positive, proven rather than asserted:** the S3 driver's request signing is hand-written, and the only thing that can vouch for a signature is a server that either accepts it or does not. `media-s3.pg-spec.ts` performs real HTTP against a real S3-compatible server (MinIO) in CI: presign, PUT, HEAD, ranged GET, DELETE, plus the three refusals that make a grant a grant — wrong content type, expired, repointed at another key.
- **Negative, disclosed (`GAP-C-01`):** MinIO is the reference implementation of the S3 protocol, not the vendor this platform will deploy against. No run against a real ArvanCloud or Liara endpoint has happened because no account exists to run one against. This suite proves the **protocol**, not the **provider** — the same distinction `GAP-06b` records for the payment gateway, and it is recorded rather than smoothed over.
- **Negative, disclosed:** with a presigned PUT the store cannot reject an oversized upload unless `content-length` is among the signed headers, and support for that varies across S3-compatible vendors — which is exactly what has not been chosen. The size cap is therefore enforced where it is enforceable against every driver: at finalize, against the size the **store** reports, with the object deleted when it exceeds the cap. A per-user bound on outstanding `pending` grants limits how much can be in flight in the meantime.
- **Negative, accepted:** search stores imagery as **URLs**, not media ids, so a URL-scheme change requires a reindex. Storing ids would require either search-service knowing about media — a dependency ADR-011 forbids — or a second round trip per search result. A reindex is a rare, planned operation the machinery already exists for.

## What is deliberately not here

**Derivative generation (thumbnails, resizing, format normalization).** The roadmap lists it under Phase C. It is not implemented, and the reason is structural rather than scheduling: with presigned direct upload the server never holds the bytes, so producing a derivative means fetching the object back, decoding it, re-encoding it, and writing new objects — a pipeline that needs a decision about whether it runs synchronously (making finalize slow and failure-prone) or asynchronously (making a portfolio item's rendition arrive after the item does, which the UI has to represent). Both are real designs; neither is a detail. Intrinsic dimensions are captured instead, which is what the zero-layout-shift requirement actually needs, and the derivative question is recorded as `GAP-C-02` rather than answered by whichever choice was quickest.

**Any UI.** Phase C's backend is complete; every screen it implies is documented for Claude Design and built later.

## What is still open

The hosting/region decision (`#1`). It does not block this ADR — the architecture it feeds was already fixed by `V3_INFRASTRUCTURE_PLAN.md` §5 — but it does block production enablement, because a bucket needs an endpoint and a credential pair. That is **external configuration**, not engineering, and it is recorded as such.
