# ADR-035: The Referral Domain — Code Identity, Server-Side Generation, and the Share Boundary

**Status:** Accepted — implemented in V3.2-C Story #11 (module, schema, code generation, share contract).
**Date:** 2026-08-31.
**Relates to:** ADR-011 (repository architecture and module boundaries), ADR-027 (subject-data contract and boot-time coverage), ADR-033/ADR-034 (the wishlist domain, whose one-table/one-module shape and no-event boundary this ADR follows closely), ADR-024 (waitlist concurrency — the same conditional-write discipline), `V3_SECURITY_MODEL.md` §3 (indistinguishable refusals, no caller-supplied identity), `V3_DATABASE_BLUEPRINT.md` §§1–4.
**Binding on:** `V32-DEC-019` and `V32-DEC-033`, closed by the product owner on 2026-08-30.
**Does not decide:** attribution, the claim route, qualification, reward values, reversal, or the abuse suite. Those are Stories #27, #12, #28, and #13, and §9 states the boundary precisely so this ADR is not read as having settled them.

## Context

A referral code is the smallest object in the V3.2-C programme and the one with the sharpest security properties. It is a **bearer credential**: whoever holds the string can, once attribution exists, claim to have been invited by its owner. Everything below follows from taking that seriously in a story that deliberately builds no attribution.

Four facts about the repository and the closed decisions shaped this ADR.

**The owner closed the share channel and the link, but not the code's own shape.** `V32-DEC-033` fixes the invite link at `{origin}/invite/{code}`, fixes copy-code and copy-link as unconditional fallbacks, and approves native share as contract and design only. It says nothing about the alphabet or the length of `{code}`. Issue #11 requires only "a CSPRNG over an unambiguous alphabet". §3 records the parameters chosen and flags them for ratification rather than presenting them as already decided.

**The owner already ratified this table's privacy disposition.** `V32-DEC-019` carries a dispositions table, and `referral.referral_codes` is `subject_data`, **deleted/revoked on the owner's erasure**, with the stated reason: *an ownerless code must not remain claimable*. That is a closed decision, not an engineering choice, and §6 implements it literally.

**The platform has no signup event and no `isNewUser` signal.** This is why Issue #11 separates attribution into its own five-point story. It is also why this story must not emit anything: there is no consumer for a referral fact yet, and `V32-DEC-033` names the only two approved events — `ReferralQualified` and `ReferralReversed` — as belonging to the reward path, while stating that `ReferralAttributed` **is deliberately not defined** because it has no consumer.

**A referral code is exactly the kind of string that leaks into logs.** It is short, printable, and looks like an identifier, so it reads as harmless in a log line or a metric label. `V32-DEC-033` forbids it in event payloads, notification payloads, analytics dimensions, metric labels, and log lines. §8 makes that structural rather than remembered.

## Decision

### 1. A `referral` module owning a `referral` schema, and `referral` joins `ServiceName`

`V32-DEC-019` and `V32-DEC-033` both speak of a referral domain with its own tables, and the reward path will need `ReferralQualified` and `ReferralReversed` — events whose producer must be nameable.

`referral` is therefore added to the closed `ServiceName` union **now**, in the story that creates the module, even though this story emits nothing. That is deliberate and is the opposite of the call ADR-033 made for `wishlist`:

- `wishlist` was kept **out** of `ServiceName` because it emits nothing *and never will* — a popularity or lifecycle event is refused outright by `V32-DEC-021`.
- `referral` goes **in** because two of its events are already approved by name in `V32-DEC-033`. Leaving it out would mean the reward story cannot declare its producer without first editing a closed vocabulary, and an event whose producer is not in the union is not declarable at all.

Adding the member declares nothing and emits nothing. §7 records that this story ships no event, no outbox table, and no contract.

### 2. One table, and the two constraints are the whole design

```
referral.referral_codes
  id             UUID PRIMARY KEY
  owner_user_id  UUID NOT NULL  UNIQUE     -- one active code per owner
  code           VARCHAR(16) NOT NULL UNIQUE  -- globally unique
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
```

`UNIQUE (owner_user_id)` and `UNIQUE (code)` are both mandated by `V32-DEC-019` ("**one referral code per owner**") and Issue #11. They are not conveniences on top of an application check — they are the only mechanism, which is what makes §4's generation strategy safe.

**No `expires_at`.** `V32-DEC-033` states the invite link has no independent expiry and that its validity follows the code and the referral lifecycle. A column nothing sets would be a third clock and a state nobody can explain.

**No `revoked_at` in this story.** Erasure **deletes** the row (§6), which is the disposition `V32-DEC-019` chose, and a soft-revocation column would make that claim false in the schema while it was true in the code. A future revocation state that is not erasure is a migration and a decision, not a nullable column added speculatively.

**No display, share, or usage columns.** No `share_count`, no `last_shared_at`, no `claimed_count`. Each would be an analytics fact this story is forbidden to collect, and the absence is structural: there is no column that could hold one.

### 3. The code: CSPRNG over an unambiguous alphabet — parameters recorded, and flagged

**This is the one place this ADR chooses a parameter the owner has not ratified.** It is recorded here plainly rather than buried in an implementation.

**Alphabet — 31 characters.** Crockford Base32 (which already excludes `I`, `L`, `O`, and `U`) with `0` additionally removed:

```
Crockford Base32:  0123456789ABCDEFGHJKMNPQRSTVWXYZ   (32 — no I, L, O, U)
minus "0":          123456789ABCDEFGHJKMNPQRSTVWXYZ   (31)
```

The exclusions are the point. `I`/`l`, `O`/`0`, and `U` — which Crockford drops to avoid accidental obscenity — are precisely the characters that make a code misread when it is spoken aloud, written on paper, or typed from a screenshot, which is exactly how a referral code travels. `0` goes too, because with `O` already absent it is the remaining glyph a reader most often supplies from memory. `1` is **kept**: with both `I` and `L` gone there is nothing left for it to be confused with. Uppercase only, so a code read aloud has one spelling.

**Length — 10 characters.** 31^10 ≈ 8.19 × 10^14, or about **49.5 bits** of entropy.

**Why 10 and not 6 or 8.** The code is a bearer credential and the claim route will be an authenticated but broadly reachable surface. `V32-DEC-019` throttles claims at 10 attempts per caller per hour, which bounds online guessing hard — but the throttle is a control the reward story owns, and this story must not depend on a control that does not exist yet. At 49.5 bits, an attacker making 10 guesses an hour needs on the order of 10^13 years, and even an unthrottled attacker at 10,000 guesses a second needs millennia. Six characters (≈29.7 bits) would be inside the reach of an unthrottled attacker; eight (≈39.6 bits) is defensible but leaves no margin for a future decision to relax the throttle. Ten is the first length where the code is safe **without** relying on a rate limit another story owns.

**Why not a UUID.** A referral code is read aloud and typed by hand. A 36-character UUID is unusable for that, and shortening one reintroduces exactly this decision with worse entropy per character.

**Uniform sampling, not modulo.** Bytes are drawn from `crypto.randomBytes` and rejected when they fall outside the largest multiple of 31 that fits in a byte — bytes ≥ 248 are discarded and redrawn. Taking `byte % 31` would make the first eight characters of the alphabet roughly 3% likelier than the rest: a small bias, and one that costs entropy for no reason when rejection sampling is four lines.

**No user-derived material of any kind.** Not the phone, the user id, a timestamp, a sequence, a hash of any of them, or a checksum over them. The generator's only input is the CSPRNG; **it does not receive the owner's id at all**, which makes "the code reveals nothing about its owner" a property of the function signature rather than of its body.

**Flagged for ratification.** The alphabet, the length, and therefore the entropy are engineering realisations of `V32-DEC-033`'s closed properties rather than owner decisions. If the owner wants a different length or alphabet, the change is a constant in `@beauclick/referral-contract`, a `VARCHAR` width in one migration, and a regenerated set of codes — cheap now, and progressively less so once attribution exists.

### 4. Generate-and-retry on the unique constraint, never read-then-write

**Forbidden: `SELECT 1 FROM referral_codes WHERE code = $1` followed by an `INSERT`.** Two concurrent generations that draw the same code both observe it free and both proceed; under `READ COMMITTED` the read cannot see the other transaction's uncommitted row. This is `GAP-04` in miniature, and it is the same defect `V32-DEC-019` forbids for the referrer cap, in the same words: *never a read-then-write*.

**The mechanism is the unique index.** Generate a candidate, attempt the insert, and on a unique violation against the code index generate a fresh candidate and try again, bounded at a small number of attempts. At 49.5 bits the first attempt succeeds with overwhelming probability — a collision is not a design case, it is a lottery — so the retry loop exists to be **correct** rather than to be **taken**. It is tested by forcing a collision, because a retry path that is never exercised is a retry path nobody knows works.

**Concurrency on the owner side is a different constraint and a different resolution.** Two concurrent first reads for the same owner both find no row and both insert; one loses on the owner index. The loser does **not** retry with a new code — that would mint a second code for an owner who now has one. It re-reads the winner's row and returns it, so both callers receive the **same** code. This is the shape `WishlistService.save` records for its own racing first-saves: the index is the guarantee, and the losing branch is the normal outcome rather than an error.

**The two unique violations must be told apart.** They are distinguished by constraint name, not by catching every `23505` and guessing. A handler that treated an owner conflict as a code collision would loop generating fresh codes while the real conflict never went away, and would exhaust its retries on a request that should have returned the existing row immediately.

### 5. First read creates; later reads return the same code

`GET /v1/me/referral/code` creates the caller's code if they have none, and returns it thereafter.

**This is a mutating GET, and that is worth stating rather than glossing.** It is what Issue #11 requires, and the alternative — a `POST` to mint plus a `GET` to fetch — makes every client perform a two-step dance for a resource that is conceptually always-there. What makes it defensible is that the mutation is **idempotent in the strong sense**: the first call and the thousandth produce the same row, the same code, and the same response body. There is no counter, no timestamp that moves, and no way for a caller to observe how many times the route has been called. A cache or a prefetch that issues the request twice causes nothing.

The route is authenticated and self-scoped, and the subject is `@CurrentUser().userId` and nothing else — never a body, query parameter, path segment, or header (§10).

### 6. Subject data: `subject_data`, exported to its owner, hard-deleted on erasure

Ratified by `V32-DEC-019`, implemented literally.

`referral.referral_codes` is claimed `subject_data`. Erasure **deletes** the row. The decision's stated reason is the whole argument: **an ownerless code must not remain claimable.** A code that survived its owner would be a bearer credential pointing at a subject who no longer exists — and once attribution lands, a claim against it would create a referral relationship with a party the platform has erased.

The export contains the subject's **own** code, which is consistent with `V32-DEC-019`'s binding export shape: *a referrer's export may contain their own code*. It contains no referee identity, because this story has no referees.

`owner_user_id` is named to match ADR-027's coverage heuristic, which recognises the `_user_id` suffix. A `no_subject_data` claim on this table would be rejected at boot on the strength of the column name alone. The declared disposition and its test are the guarantee; the naming is belt.

**This story claims exactly one table.** `referral.referrals`, `referral.reward_grants`, and `referral.referrer_counters` appear in `V32-DEC-019`'s dispositions table and are **not** created here — and are therefore **not** claimed here. A claim on a table that does not exist is the `claimed_but_absent` violation ADR-027 defines, and it fails the boot: a stale claim reads as coverage while covering nothing.

### 7. No event, no outbox, no notification, no analytics, no metric

This story emits nothing, and every one of those absences is `V32-DEC-033` applied rather than an omission.

There is **no `referral.outbox_events` table**. `ReferralQualified` and `ReferralReversed` are approved but belong to the reward path and have no producer yet; `ReferralAttributed` is deliberately **not defined** because it has no consumer. Declaring any of them here would ship a contract nothing publishes and nothing reads.

No notification category is registered and no notification is sent. `V32-DEC-033` restricts referral notifications to the **qualified** and **reversed** moments — neither of which exists in this story. Getting a code is not a lifecycle moment; it is the absence of one.

No analytics fact and no metric. `analytics.events` restricts `subject_type` by CHECK constraint and none of its values fits a referral code, and widening it is a migration on a shared, privacy-sensitive table that no decision authorises.

### 8. The code never leaves the authenticated read route

`V32-DEC-033`: *"A referral code is a bearer credential for attribution and never leaves the authenticated read route."*

This is enforced by there being no other path, not by redaction:

- Nothing emits an event, so no payload can carry it (§7).
- No log statement in this module takes the code. The one operational line records that a code was created for a subject id, and the code is not an argument to it.
- No metric is registered, so there is no label to attach it to.
- The export is the one place the code legitimately appears, and it goes only to its own subject (§6).

The property is asserted adversarially in the suite: a code is minted, and every outbox table, the notification table, the analytics table, and the captured application log output are searched for the literal string. It appears in none of them.

### 9. What this story is NOT, stated so the boundary is not read as an omission

**No attribution.** No claim route, no `referral.referrals` table, no referrer/referee relationship, no `isNewUser` detection. Story #27, and it is a separate story because the platform has no signup event — a design problem, not a missing line of code.

**No qualification and no rewards.** No `BookingCompleted` consumer, no loyalty grant, no `referral.reward_grants`, no `referral.referrer_counters`, no monthly cap. Stories #12 and #28. `loyalty.config.ts` already carries `pointsReferralQualified: 0` and a `referral_qualified` reason from an earlier phase; neither is touched.

**No abuse suite.** Self-referral is unrepresentable only once attribution exists, so there is nothing to prevent here. Story #13.

**No frontend and no design artifact.** Story #14. `navigator.share` is never called; what ships is the payload shape.

### 10. Authorization: authenticated, self-scoped, no new capability

No `bc_*` capability is created. The surface acts exclusively on the caller's own data and gates no privileged action — the same reasoning `journey`'s `/v1/me/journey` and the wishlist's `/v1/me/wishlist` record.

**No route accepts a caller-supplied user, owner, or customer identity**, in a body, query parameter, path segment, or header. The mount point is `v1/me/referral` rather than `v1/referral/:userId`, so there is no segment that could be mistaken for one. The global `ValidationPipe` runs with `forbidNonWhitelisted`, so a forged `ownerId` on the query string is **refused with a 400** rather than ignored — the stronger outcome, because a silently-ignored field is one somebody later wires up by accident.

There is **no route that reads another party's code**, so the platform's indistinguishable refusal boundary is preserved by there being no question to ask. `NotFoundOrNotYoursException` is not thrown by this module because no path in it can reach a resource that is not the caller's.

### 11. The browser contract: `@beauclick/referral-contract`, zero dependencies

The fifth package of this shape, after payment, AI, chat, and wishlist, and for the reason each of those records: the page needs the alphabet, the code length, the invite-link shape, and the share payload, and importing the domain to get them would drag `@nestjs/common`, `typeorm`, and every entity into a browser bundle.

It carries the code alphabet and length, the invite path segment, the share payload shape, and the closed vocabularies — and **no** reward value, point total, cap, or attribution vocabulary, because those belong to decisions this story does not implement.

`shareText` is assembled from a **fixed template plus the code**, per `V32-DEC-033`: not free text, not stored, and carrying no personal data. **The template shipped here is engineering-authored placeholder copy.** Approved referral legal and disclosure copy is a public-release gate under dependency-ledger blocker 16 and does not block this backend milestone — so the template is deliberately neutral, names no person, and **never states or implies that BeauClick sent an invitation**. The referrer sends it.

## Consequences

- A customer has a stable referral identity from their first read of one route, and it never changes.
- The code is safe against online guessing without depending on the claim throttle, which does not exist yet.
- Erasure destroys the code, so an ownerless code cannot be claimed once attribution lands.
- The reward stories inherit a `ServiceName` member, one table, and one contract package. They add attribution, qualification, and rewards; they do not revisit code identity.
- A different alphabet or length remains cheap to change until attribution exists, and progressively less so afterwards. §3 flags it.
- Because the route creates on read, a client that has never called it has no code — there is no backfill, and none is needed.

## What is deliberately not decided here

- **The exact alphabet and length as an owner-ratified parameter** — chosen and justified in §3, flagged for ratification.
- **Approved share, legal, and disclosure copy** — a public-release gate, not a backend gate.
- **Attribution, qualification, rewards, reversal, and the abuse suite** — Stories #27, #12, #28, #13.
- **Any revocation state that is not erasure** — a migration and a decision if it is ever wanted.
- **Platform-sent SMS, email, push, and every social-network share API** — externally gated by dependency-ledger rows 6 and 7, and not claimed as delivered.
