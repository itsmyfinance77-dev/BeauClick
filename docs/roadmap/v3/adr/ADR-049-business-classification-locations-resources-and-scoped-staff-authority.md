# ADR-049 — Business classification, locations, bookable resources and scoped staff authority

**Status:** Accepted — 2026-09-07
**Approver:** product owner (`V33-DEC-030` ratified 2026-09-06; `V33-DEC-032` ratified 2026-09-07)
**Backlog:** #44 (umbrella)
**Constrains:** #107 (`#44a`), #108 (`#44b`), #109 (`#44c`), #110 (`#44d`), #111 (`#44e`)
**Binding authorities:** [`V33-DEC-030`](../../v3.3/V3.3_DECISION_REGISTER.md) (structure, contract and
security for the whole family) and [`V33-DEC-032`](../../v3.3/V3.3_DECISION_REGISTER.md)
(classification cardinality). Neither is reopened, re-decided or weakened here.
**Depends on:** [ADR-023](ADR-023-business-seller-domain.md) (business is its own seller party;
`owner` is never a `business_staff` row; consent is structural),
[ADR-027](ADR-027-subject-data-contract.md) (the self-registering subject-data contract and its
boot-time coverage assertion), [ADR-011](ADR-011-repository-architecture.md) (module boundaries),
[ADR-017](ADR-017-financial-isolation-and-money.md) (financial isolation and the append-only
ledger), [ADR-018](ADR-018-cross-domain-consistency.md) (same-cluster consistency),
[ADR-024](ADR-024-waitlist-concurrency.md) (the exclusion-constraint-plus-lock concurrency
pattern), [ADR-039](ADR-039-commercial-policy-control-plane.md) §6 (identity, workspace role and
vertical are different axes)

**This ADR is the mandatory pre-code gate `V33-DEC-030` requires.** It is committed alone, as
its own pull request containing exactly one new file. It writes no schema, no migration, no
route, no DTO, no service, no contract, no event, no capability, no index, no seed and no test,
and it activates no provider, payment, settlement, deployment, tag or release. It publishes no
commercial value and is **not Legal approval**.

**How to read the rules below.** Each one is marked either **Today** — a fact already true of
the merged repository, verified against
`25047d5bdd46d6b6e30ebb43b50c6adabb81eb37` before this ADR was written — or **Obligation
(#issue)** — something a named child must make true before its own code is complete. Nothing
below claims that a planned table, column, route, capability or test already exists.

---

## Context

`V33-DEC-030` decomposed Story #44 into five children after a readiness audit found it
unstartable as written, and required a single family ADR before the first schema, contract or
executable line of **any** of them. `V33-DEC-032` then closed the one product question
`V33-DEC-030` had left open — how many verticals a business may carry, and whether an
unclassified business is legal.

Both decisions are ratified. What is still missing is the layer between a ratified product
decision and an implementer's keyboard: which module owns which fact, which invariant is
enforced by PostgreSQL rather than by code, what a failure looks like from outside, what the
privacy disposition of each new table will be, and — for the three questions the children's own
issues explicitly deferred to this ADR — the answer.

Three of those deferred questions are settled here rather than improvised inside a story:

1. **What happens when an invitation names a phone number with no account** (`#44c`, and
   ADR-023's "what was deliberately not built").
2. **How `financial`'s workspace enumeration extends from *owned* to *owned ∪ live-scoped*
   without weakening any predicate #72 established** (`#44e`).
3. **Whether closing a location blocks or cascades with respect to its resources' future
   assignments** (`#44d`).

The family also inherits four engineering obligations `V33-DEC-032` R8 bound to #107. They are
recorded here because three of them are architectural rather than incidental: they decide where
an invariant lives.

---

## Decision

### 1. Organisation and taxonomy

**1.1 `business.businesses` is the organisation, and stays so.** **Today** it is the seller
workspace: `ServiceCatalog` and `FinancialPartyResolver` both resolve a seller party through
`SellerPartyLookup`, and `commerce.orders` and `financial.ledger_entries` carry that party
verbatim. **Locations are children of that row.** No child of #44 may introduce a parent
organisation above `business.businesses`, re-key it, or re-point an existing business, order,
seller-party or ledger row. The append-only ledger (ADR-017) makes that irreversible, which is
why the rule is structural rather than advisory.

**1.2 The vertical vocabulary is exactly `salon | clinic | maison | retail | wholesale |
academy`.** Closed, enforced by a database CHECK constraint, and gaining no seventh member
without a new register decision.

**1.3 The operating-trait vocabulary is exactly `multi_location | mobile`,** carried as an
**independent additive set** on its own axis — never a second enum column, never a member of
the vertical vocabulary. A salon that opens a second branch stays a salon and gains a trait.

**1.4 A business has at most one vertical.** **Obligation (#107):** the vertical table's
identity is `business_id` as its **primary key**. There is **no `is_primary` column, no
secondary vertical row, no independent surrogate id whose only purpose is to permit several
rows, no sentinel vocabulary member, no default and no inferred backfill.** The key *is* the
invariant; no partial index, application check or trigger may be the arbiter instead.

**1.5 Unclassified is legal, and is represented only by the absence of a row.** A read of an
unclassified business returns that absence truthfully. It is not an error, not a state to be
repaired, and not a value to be invented. **Obligation (#107):** business creation is
unchanged — `POST /v1/businesses` neither requires nor accepts a vertical, and `CreateBusinessDto`
gains no field. **Today** `BusinessService.create` writes no classification at all, so this rule
is the only one that leaves every existing row honest.

**1.6 Traits are identified by `(business_id, trait)`** and may be absent, singular or both.
Their absence is likewise legal and likewise never backfilled.

**1.7 Classification and traits authorize nothing.** Neither a vertical nor a trait grants any
permission, capability, financial access or booking authority — alone, or in combination with a
membership row, a scoped grant or an opaque reference. **Obligation (#107):** this is proved by
a structural test asserting that no authorization function, guard, resolver or port reads either
table, not by review. **`clinic` is a commercial label only.** It introduces no medical,
diagnostic, treatment, contraindication, medication, allergy, skin-condition or clinical
before/after data, and confers no medical authority; a test must prove `clinic` grants nothing
`salon` does not.

---

### 2. Ownership and business lifecycle safety

**2.1 Owner authority is always derived live from `businesses.owner_id`.** **Today** that is
exactly what `StaffService.roleFor` does before consulting `business_staff`, and what
`BusinessOwnerResolver` reads. **`owner` never becomes a `business_staff.role` value, a scoped
grant, or any other editable row.** ADR-023's reasoning is unchanged: a stored owner is a row
that can be edited, removed or raced against, and the ownership predicate stops being a lookup.

**2.2 One user owns at most one active business organisation** for V3.3/MVP. Multi-location is
child locations under one organisation, never several business rows. Multi-entity ownership,
ownership transfer and owner-erasure succession remain **explicitly future work** with no issue
created by this ADR.

**2.3 The active-owner uniqueness repair is one atomic change.** **Today**
`uq_businesses_owner_id` is unconditional while `BusinessService.create` guards on
`deletedAt: IsNull()`, so a soft-deleted business would pass the service check and raise an
uncaught `23505`. It is latent only because nothing writes `businesses.deleted_at` yet.
**Obligation (#107), and all four parts land in the same change:**

1. `uq_businesses_owner_id` becomes unique on `owner_id WHERE deleted_at IS NULL`;
2. the contradictory TypeORM `unique: true` metadata on `BusinessEntity.ownerId` is removed in
   favour of the entity-level partial form `BusinessStaffEntity` already uses, so the ORM's
   schema and the migration's schema cannot disagree;
3. `StaffService.roleFor` filters to the live row;
4. `BusinessService.update` filters to the live row.

Parts 3 and 4 are not tidying. The instant part 1 lands, one user can own a soft-deleted row
**and** a live row, and `BusinessOwnerResolver` — which reads `roleFor` — would grant owner
authority over both. Shipping 1 without 3 converts a latent `500` into a live authorization
defect. `BusinessService.update` has the same omission today and lets `PATCH /v1/businesses/:id`
edit a soft-deleted business, while `findById` and `findByOwner` both filter correctly.

**2.4 Real PostgreSQL is authoritative for partial-index, transaction, lock and concurrency
proofs.** **Today** the in-memory pg-mem DataSource honours neither `ROLLBACK` nor partial
unique indexes, and its own docblock forbids citing it as evidence for a transactional
guarantee. Every child's atomicity, isolation, locking, exclusion-constraint and
partial-index claim must be proved in a real-PostgreSQL spec. pg-mem stays useful for schema,
query and shape coverage and must never be cited for the properties it cannot model.

**2.5 Class-level `@ResolveOwner` is forbidden across this family.** **Today** `OwnershipGuard`
reflects `OWNER_RESOLVER_KEY` from `context.getHandler()` only; a decorator written on the
controller is silently ignored, and every route on it loses its ownership check while the
decorator above the class reads as protection. That is the exact failure shape `CapabilityGuard`
was repaired for — it now reads handler **and** class through `getAllAndOverride` — and the two
guards genuinely differ today. **This ADR avoids the hazard rather than silently repairing it:**
every protected handler in #107–#111 declares `@ResolveOwner` directly on the handler, and no
child may add a class-level form. Repairing `OwnershipGuard` is a separate change with its own
blast radius across every existing controller, and it is not smuggled into a business-operations
story.

---

### 3. Locations

**3.1 A location is a child of exactly one organisation** and carries its own name, its own city
reference and its own lifecycle. **Obligation (#108):** the lifecycle vocabulary is exactly
`active | suspended | closed`, closed by a CHECK constraint.

**3.2 The city vocabulary is the existing `provider.locations_cities`,** crossed as an **opaque
UUID through a port**. `business` imports no `provider` ORM entity; ADR-011's boundary and the
`scope:business` → `scope:shared` lint rule both stand. **Today** `provider.locations_cities
(id, name, is_launched)` is the only geography table in the platform: there is no province,
district, neighbourhood, address or coordinate anywhere, and none is built by this family.

**3.3 `businesses.city_id` is deprecated as a *service-delivery location* only when the location
child contract ships,** and **not before**. **Neither this ADR nor #107 drops, renames,
reinterprets, migrates or rewrites that column.** #108 records the deprecation in the schema
comment and in its contract; the column, its constraints and every value in it are preserved
byte-identical. A later migration owes a compatibility story and an explicit backfill definition
*before* removal may even be proposed.

**3.4 Location references are opaque and separately domain-separated.** A `locationRef` is an
identifier, never an authorization: nothing is ever looked up *from* one, exactly as
`workspace-reference.ts` already documents for `workspaceRef`. **Obligation (#108):** the
`locationRef` uses its own domain-separation prefix, so `WORKSPACE_REFERENCE_DOMAIN`'s golden
test stays **byte-identical** and a `locationRef` presented where a `workspaceRef` is expected
cannot match.

**3.5 Location lifecycle and every mutation rule follow #108's ratified issue contract.** Create,
rename, suspend and close are **owner-only** in #108, resolved from live `businesses.owner_id`;
scoped delegation of location edit is `#44c`'s, not #108's. No order, booking or ledger row is
re-pointed by any location change, and a single-site business with no location row behaves
exactly as it does today on every surface.

---

### 4. Staff membership, invitation and scoped grants

**4.1 `business_staff.role` is not widened, and `owner` is never added to it.** **Today** the
role vocabulary is `manager | staff`. New authority is a **scoped grant**, not a wider role
string, because a wider string loses the scope dimension entirely and detaches authority from
consent.

**4.2 A scoped grant attaches to a consented membership row.** **Obligation (#109):** the grant
table is anchored on `business_staff.id` — never on a user id, a phone number, a role string, a
vertical, a trait or an opaque reference. Anchoring on the membership is what keeps consent
**structural**: ADR-023's rule that a row starts `invited` and only the invitee's own
authenticated session may move it to `active` means a grant cannot exist for someone who has not
accepted. Anchoring on a user id would quietly restore the hazard ADR-023 closed.

**4.3 Bare membership grants no new authority.** Each scoped authorization is **explicit**,
**narrowly enumerated** by a closed vocabulary, and **live-rechecked on every request**.
Revocation is effective on the **next request**, and a stale access token carrying a valid
capability claim but a revoked grant is refused. That is a stronger property than the
access-token TTL and is the reason the check is a live read rather than a token claim.

**4.4 The scopeless privileged verifier is not widened.** **Today**
`PrivilegedCapabilityVerifier.hasCapability(userId, capability)` takes no scope, and
`PRIVILEGED_CAPABILITIES` is the single list shared with `libs/audit`'s boot assertion.
**Obligation (#109):** a **separate scoped verifier port** is introduced, carrying explicit
business/location/resource scope, and bound at the composition root. Adding a scope parameter to
the existing port would change the meaning of every existing privileged call site, and a
scope-less call against a scoped verifier is exactly the confused deputy this separation
prevents.

**4.5 Invitation input is a phone number, resolved server-side.** **Today**
`InviteStaffDto.userId` requires the owner to already know the invitee's identity UUID, so every
scoped role would ship administratively unusable. **Obligation (#109):** the inviter supplies a
phone number; resolution happens server-side; **the phone number and any resolved identity are
never echoed back**; and **no public user directory or search over users is created or
authorized**.

**4.6 A phone number with no account: persist nothing, notify nothing.** This is the question
ADR-023 left open and `V33-DEC-030` D5 required this ADR to answer before code. **The rule is
the privacy-minimal one:**

- **No pending-invitation row is written.** No speculative, PII-bearing record of "someone tried
  to invite this phone number" is created — not in `business`, not anywhere. A row keyed by a
  phone number that belongs to no account is personal data about a person who has no
  relationship with the platform and no way to see, correct or erase it, and ADR-027's whole
  model presumes a subject the platform can act for.
- **No notification is sent.** An SMS to an unknown number would both disclose that someone
  named them to a business and turn the invite surface into an unauthenticated send primitive.
- **The response is the same non-enumerating refusal envelope, in the same timing class, as
  every other refused resolution** — unknown, ineligible, duplicate and foreign cases are
  externally indistinguishable in body, status **and** timing. #109 proves this by comparing
  responses and timing across all five cases, not by inspection.
- **A future "invite before signup" feature requires a new owner and privacy decision and its own
  schema.** It is named here so it is a decision rather than a discovery, and no issue is created
  for it.

**4.7 A known, eligible account uses the existing consent-bearing lifecycle, unchanged.**
Persistence begins only with a `business_staff` row at `invited`, created by someone who is not
the invitee; **only the invitee's own authenticated session may accept**. If #109's contract
requires a notification, it is sent **only after the transaction commits**, and it may not reveal
the phone number or the resolved identity to anyone but the invitee. A notification inside the
transaction can be delivered for an invitation that then rolls back.

**4.8 The `business_staff.status` mismatch is corrected in #109, and nothing beyond it is
invented.** **Today** three sources disagree: `BUSINESS_STAFF_STATUSES` is
`['invited','active','inactive','declined']`, the column carries **no CHECK constraint**, and
`BusinessSubjectDataContract.eraseSubjectData` writes `status = 'removed'` — a value neither the
type nor the database knows. **Obligation (#109):** reconcile the vocabulary to include
`removed` and add the missing CHECK over exactly that vocabulary, with existing rows
byte-identical. **No new lifecycle state, transition or actor beyond #109's issue contract is
introduced by this correction.**

> **Amendment note — 2026-09-08, `V33-DEC-033`.** Nothing in §4 above is rewritten,
> reopened or weakened. Three points this section deliberately left to #109's own
> contract were ratified by [`V33-DEC-033`](../../v3.3/V3.3_DECISION_REGISTER.md) and are
> recorded here only so they are discoverable from the ADR that binds the family:
> (1) the closed scoped-role vocabulary for #109 is **exactly one member**,
> `practitioner_chat`; (2) that role is **practitioner-specific, not business-wide** —
> at authorization time the qualifying booking's `professional_id` must equal the
> grantee membership's `professional_id` and the order's snapshotted seller business
> must equal the grant's business, with **no third generic scope form** added and the
> membership's `professional_id` resolved server-side; and (3) §4.6's "persist nothing,
> notify nothing" extends explicitly to **transient queued derivatives** — no phone
> hash, encrypted phone, lookup token or queued work item may be written for an absent,
> ineligible, duplicate, foreign or self case, so invitation resolution is fully
> synchronous with a monotonic-clock minimum-duration floor rather than queued.

---

### 5. Scoped finance

**5.1 What a finance grant is.** **Obligation (#111):** an explicit, business-scoped,
**read-only** grant to exactly **that one business's** own finance surface, created and revoked
by the business owner only, through #109's grant store, with transactional audit.

**5.2 What it is never.** It confers no ownership of the business or its party; no settlement,
payout, refund or clawback authority; **no ledger mutation of any kind**; no cross-workspace or
cross-business aggregation; and no access to any other business — including another business
owned by the same person. Finance **writes** remain entirely outside this family.

**5.3 Affiliation still grants nothing.** `V33-DEC-020` Ruling 1 is unchanged and unweakened.
**Today** `FinanceWorkspaceService` exists precisely because affiliation-derived permission was
the #72 defect: `SellerPartyLookup` follows an active `business_staff` row to answer *whose money
is this*, which is attribution, and `FINANCE_WORKSPACE_OWNER_RESOLVER` answers *who may act on
this workspace*, which is permission. **Obligation (#111):** `SellerPartyLookup`'s affiliation
behaviour stays byte-identical, asserted by test, and every existing assertion in the #72
authorization suite passes **unchanged** — not adjusted, not relaxed, not deleted.

**5.4 The `workspaceRef` question #111 deferred here is settled: extend the enumeration, never
the derivation.** **Today** a reference is `HMAC(secret, sessionUserId, {partyType, partyId})`
over a length-prefixed input under a single versioned domain prefix; it is *matched*, never
looked up from; and `FinanceWorkspaceService` derives it for the **session user** against the
parties that session owns. The reference is therefore already **viewer-anchored**, which is what
makes a stolen reference inert.

The ruling:

- **No second reference kind and no second domain prefix for finance.** `WORKSPACE_REFERENCE_DOMAIN`,
  `workspaceReferenceInput`, `deriveWorkspaceReference` and the length-prefixed encoding are
  **unchanged**, so the golden test stays byte-identical and every reference #69 and #72 ever
  issued still resolves.
- **Only the enumeration changes**: the port that answers *which parties may this session
  address* returns `owned ∪ live-scoped-read` instead of `owned`. Because derivation still binds
  the **session user**, a grantee's reference to business B is a different value from the owner's
  reference to business B, is useless in any other session, and stops matching the instant the
  grant is revoked — revocation needs no new mechanism, exactly as ownership needs none today.
- **The enumeration result carries an explicit access mode** (`owner` or `scoped_read`), and
  **every finance write path requires `owner`**. Returning an undifferentiated party list would
  make a read grant indistinguishable from ownership one call later; the mode is what stops a
  read-only grantee reaching a write path, and #111 proves it **route by route** rather than by
  inspection.
- **No existing predicate is weakened.** Ordering still never selects a workspace; every read
  still names one by reference; an empty collection is still a truthful answer rather than a
  `404`; and `financial` stays on its own DataSource and role.

**5.5 Live re-check and immediate revocation** apply exactly as in §4.3. A revoked finance grant
loses access on the next request; a stale token with a valid claim and a revoked grant is
refused.

---

### 6. Bookable resources and booking integrity

**6.1 `booking.bookings.professional_id` remains byte-identical** and keeps identifying the
practitioner who owns the calendar. `booking.availability_slots.professional_id` likewise.
Neither is replaced, re-keyed or made nullable. `V33-DEC-006` and ADR-023 stand: fulfilment is
professional-keyed, and a location or a resource is never the booking axis.

**6.2 A resource is a side-table fact under a location.** **Obligation (#110):** resources hang
off a `business.locations` row; the only new table in the `booking` schema is the
assignment table that joins an opaque resource id to a booking's time range. Resource ids cross
the module boundary as **opaque UUIDs through a port** — `booking` imports no `business` ORM
entity, asserted by `@nx/enforce-module-boundaries`.

**6.3 Collision is enforced by a *second* PostgreSQL exclusion constraint,** in that new side
table, over (resource, time range). **Today** `ex_availability_slots_no_overlap` guards
`(professional_id, tstzrange)` on `booking.availability_slots`, and `btree_gist` is already
installed. **The existing constraint is not modified, extended or replaced** — the practitioner
axis and the resource axis are two independent invariants, and merging them into one constraint
would make a resource change able to break slot generation.

**6.4 Assignment and slot claim happen in one transaction, with deterministic lock ordering.**
There is no window in which a booking exists without its resource, or a resource is held without
a booking; a rollback of either rolls back both. Cancelling or rescheduling frees the resource in
the same transaction. **Obligation (#110):** lock acquisition order is fixed and documented so
two concurrent claims touching the same slot and the same resource cannot deadlock by taking
them in opposite orders, and the proof is a **genuinely parallel** real-PostgreSQL spec, not
sequential inserts.

**6.5 A collision is a refusal, never a `500`.** PostgreSQL `23P01` maps to the existing
non-enumerating availability refusal. **Today** the codebase already treats `23P01` and `23505`
as one "the database rejected an overlap" outcome in `availability.service.ts` and maps it to a
domain refusal; #110 follows that precedent rather than inventing a second shape. A caller cannot
distinguish "that room is taken" from "no such room", "not your business" or "that location is
closed".

**6.6 Closing a location is *blocked* while future resource assignments exist — never
cascaded.** This is the choice #110's issue explicitly deferred to this ADR. Retiring a resource
is blocked on the same condition. The reasoning is that a cascade would let an administrative
lifecycle change on a location silently mutate **booking** facts — cancelling, orphaning or
double-booking appointments customers already hold — and `booking` is the module ADR-023 was
written to protect. Blocking is recoverable by an explicit human action; a cascade is not.
Both refusals use the same non-enumerating shape as §6.5, so the block leaks nothing about which
resources or bookings exist.

**6.7 Nothing in this family independently authorizes a booking mutation.** Not a resource, not a
location, not a classification, not a membership row, not a scoped grant, not an opaque
reference. **Delegated receptionist mutation of another practitioner's calendar — creating slots,
cancelling, rescheduling, completing or marking a no-show on their behalf — is explicitly not
authorized by this ADR**, remains a separately governed future decision, and has no issue.

> **Amendment note — 2026-09-09, `V33-DEC-034`.** Nothing in §6 above is rewritten,
> reopened or weakened; §6.1–§6.7 stand exactly as ratified. What changed is the
> **delivery vehicle**, recorded here so it is discoverable from the ADR that binds the
> family. A read-only audit of #110 established from code that this section's obligations
> presuppose a fact the model does not contain: **there is no authoritative
> booking→location edge**. `CreateBookingInput` carries no location, the `booking` schema
> contains the token `location` nowhere at all, `provider.services` binds only to a
> professional, the only professional→organisation resolver stops at a **business**, and a
> business has **0..N** locations — while §3.5 makes a business with no location row legal
> and `V33-DEC-033` R2 had already ratified that **"a location owns no bookings"**.
> Automatic resource selection is therefore not implementable as a step inside #110; it
> would reduce to first-row selection that passes on a single-branch business and silently
> assigns wrong-branch resources on a multi-branch one.
>
> [`V33-DEC-034`](../../v3.3/V3.3_DECISION_REGISTER.md) accordingly splits `#44d` into
> **three** stories — `#110a` (#110, the resource catalogue), `#110c` (#127, the delivery
> context this section needs and does not have) and `#110b` (#128, the assignment and
> collision core §6.3–§6.6 describe) — re-estimated **13 → 21 SP**. `#110b` **must not
> begin** until `#110c` supplies an authoritative delivery context. The card also confirms
> three things §6 left to #110's own contract: the closed resource-kind vocabulary is
> exactly **`room | device | station`**; catalogue mutation is **owner-only**, adding no
> scoped-staff role and leaving `SCOPED_STAFF_ROLES` byte-identical; and §6.6's
> blocked-close obligation belongs to **`#110b`**, because during `#110a` no assignment
> table exists and the test would pass for the wrong reason. `V33-DEC-034` authorizes **no
> column or table** for `#110c`: `availability_slots.location_id`, an
> `availability_slots.resource_id`, a slot side table and a service/location column all
> remain unauthorized pending that story's own readiness audit.

---

### 7. Privacy, audit and failure contracts

**7.1 Every new table gets an explicit ADR-027 disposition, owned by the module that owns the
table.** **Today** `SubjectDataCoverageService` reads `pg_tables` at boot and requires every
table in every non-system schema to be claimed by exactly one contract as `subject_data`,
`retained` (with a reason) or `no_subject_data` (with a reason); an unclaimed table, a stale
claim, a double claim, or a `no_subject_data` claim on a subject-shaped column **fails startup**.
Each child extends its own module's contract and proves the exact-set assertion still fails
startup for an unclaimed table — the negative control, not just the passing case.

**7.2 The expected disposition categories, without fabricating columns.** Each child finalizes
its exact table-level claim before code; these are the categories the claims must fall into, and
the reasoning that decides which:

| Kind of fact | Expected disposition | Why |
|---|---|---|
| Organisation classification and operating traits (#107) | **`retained`**, with a reason | A property of a commercial entity, not of a person. It survives the erasure of any individual, exactly as `business.businesses` already does, and it names nobody |
| Membership-anchored scoped grants (#109) | **`subject_data`** | A grant names a person's authority. Export must return the grantee's own grants and must **not** disclose the granting actor's identity; erasure must revoke live grants in the **same transaction** as the membership change |
| Locations (#108) and resources (#110) | **`retained`** or **`no_subject_data`**, with a stated reason | Organisational facts. A claim of `no_subject_data` is only available if the table genuinely carries no subject-shaped column; if it carries an actor column, it is not eligible |
| Booking/resource assignment facts (#110) | **`retained`**, with a reason | Immutable operational history retained under the obligations that already govern `booking.bookings`; deleting it would corrupt a professional's records for no privacy gain |

**7.3 Actor identity must be *detectable*.** **Today** the coverage cross-check recognises
`user_id`, `customer_id`, `owner_id`, `actor_id`, `subject_id`, `cancelled_by_actor_id`, `phone`
and `email`, plus any column ending `_by` or `_user_id`; its own docblock records that a table
could evade the heuristic by inventing a name no other table uses. **No table in this family may
be that table.** Every column holding a person's identity uses the `*_user_id` or `*_by`
convention, so a wrong `no_subject_data` claim is caught by the boot assertion rather than by
someone noticing.

**7.4 Every mutation is audited transactionally, with a closed action and reason vocabulary,**
written on the same `EntityManager` as the change it records. **Today** `libs/audit`'s boot
assertion enforces `@AuditAction` **only** on mutations declaring a capability in
`PRIVILEGED_CAPABILITIES`, and `BusinessController` is `@Controller('v1')` with no capability at
all — so **none of this family's routes is covered by that structural enforcement**. Every child
therefore proves its audit guarantee **directly by test**, including the rollback case, in a
real-PostgreSQL spec. Nobody may cite the boot assertion as evidence for a non-privileged
business route.

**7.5 Externally indistinguishable causes stay indistinguishable.** Where two failure causes must
not be told apart, the response is **byte-identical in body and status** and the timing is in the
same class. **Today** the platform has one such shape and one message,
`NOT_FOUND_OR_NOT_YOURS`, used for both "does not exist" and "not yours" everywhere; this family
reuses it rather than adding a bespoke `403` that would let a caller tell them apart. Internal
metrics and logs use a **bounded cause label** and never contain a phone number, an identity, an
opaque reference, a policy value or an amount.

**7.6 Reads never write.** No `GET` in this family performs lazy initialization, creates a
default row, or repairs state. An unclassified business is not classified by being read; a
missing location is not created by being listed.

---

### 8. Module boundaries, dependency order and migration ordering

**8.1 Ownership of facts.** `business` owns the organisation, its taxonomy, its locations, its
memberships and its scoped-grant facts. `booking` owns booking and resource-collision facts.
`financial` owns financial reads. The **composition root** binds every cross-domain port.

**8.2 No service imports another service's ORM entity or implementation.** **Today**
`@nx/enforce-module-boundaries` permits each `scope:<domain>` to depend on `scope:shared` alone,
and that is not relaxed for this family. Where transaction atomicity crosses a domain — #110's
resource assignment inside the slot-claim transaction is the only such case here — the crossing
is a **narrow, manager-scoped port**: the port method accepts the caller's `EntityManager` so the
work joins the caller's transaction instead of opening a second connection that cannot be rolled
back with it.

**8.3 This ADR authorizes no implementation of its own.** It constrains #107–#111 within the
scopes their issues and `V33-DEC-030`/`V33-DEC-032` already ratified, and it widens none of them.
It fixes no commercial or legal value, and it is not Legal approval.

**8.4 Dependency and migration order.** ADR-049 first, then:

```
#107 (#44a) -> #108 (#44b) -> #109 (#44c) -> #111 (#44e)
                    \             \
                     +-------------+--> #110 (#44d)
```

`#110` depends on **both** `#108` (a resource hangs off a location) and `#109` (authority over a
resource is a scoped grant or live ownership). `#111` depends entirely on `#109` for the grant
store, the scoped verifier port and live re-checking. #104's deferred per-service
commercial-policy override waits for `#107`–`#109` and is absorbed into none of them. #45 is
untouched design work that consumes these contracts.

**Migration ordering rules.** Each child's migration is a separate, forward-only file in its own
schema directory, and each is idempotent and runs inside the runner's own transaction — so
`CREATE INDEX CONCURRENTLY` is unavailable and must not be attempted. A child may not depend on
a later child's table. #107's four-part repair (§2.3) is **one migration plus the code changes it
requires, in one commit**; splitting it across two merges is the defect described there.

---

## Considered and rejected

| Rejected | Why |
|---|---|
| Keeping `multi_location` and `mobile` in the vertical enum | Forces orthogonal axes into one mutually exclusive set: a branching salon would have to stop being a salon. Corrected by `V33-DEC-030` D1 |
| Free-form vertical tags | Unqueryable, unconstrained and unreportable; nothing could be closed by a CHECK |
| Primary plus secondary verticals, with a partial index on a primary marker | Silently introduces a product concept nothing defines: what a secondary vertical means, who may set it, whether it is exported, what reads it. The mechanism would create the concept. Rejected by `V33-DEC-032` R2 |
| A default, backfilled or sentinel classification for existing businesses | Invents an answer the owner never gave, and destroys the difference between "not yet answered" and "answered". A wrong classification is worse than an absent one |
| A `NOT NULL` vertical column on `business.businesses` | Rewrites the table `V33-DEC-030` D2 refused to rewrite, and breaks #107's byte-identical criterion |
| Making `businesses` a location under a new parent organisation | Re-points the seller party of every existing order and every append-only ledger row (ADR-017). Irreversible, for a modelling preference |
| Allowing one user several active businesses now | Re-opens the silent single-business selection `V33-DEC-020` closed in two resolvers, with no ratified rule for choosing between them |
| Adding `owner` to `business_staff.role`, or widening that column for new authority | Re-opens the edit/remove/race hazard ADR-023 closed, breaks the ownership predicate `V33-DEC-020`/`V33-DEC-021` rest on, and loses the scope dimension entirely |
| Anchoring scoped grants on a user id, a phone number or a role string instead of the membership row | Detaches authority from consent: a grant could exist for someone who never accepted an invitation |
| A public user directory or any search over users, to make invitation usable | Violates non-enumeration and the privacy question ADR-023 named; the phone-resolution rule solves the usability problem without it |
| Persisting a pending invitation, or notifying, for a phone number with no account | Creates PII about a person with no platform relationship and no way to see, correct or erase it, and turns the invite route into an unauthenticated send primitive. §4.6 |
| Widening the scopeless privileged capability verifier with a scope parameter | Changes the meaning of every existing privileged call site, and a scope-less call against a scoped verifier is the confused deputy the separation prevents |
| Finance access derived from `business_staff` affiliation | `V33-DEC-020` Ruling 1. It is the exact #72 defect; attribution is not permission |
| A second reference kind or a second domain prefix for scoped finance | Would give one workspace two ids for no isolation gain, risk the golden test, and duplicate a cryptographic construction — two implementations of one MAC are one waiting to disagree. §5.4 extends enumeration instead |
| Returning an undifferentiated party list from the extended finance enumeration | A read grant would become indistinguishable from ownership one call later. The explicit access mode is what keeps write paths owner-only |
| Resources replacing `professional_id` as the booking axis | Rewrites the platform's highest-risk concurrency surface for a feature that does not need it; `V33-DEC-006` and ADR-023 stand |
| Extending the existing slot exclusion constraint to cover resources | Makes a resource change able to break slot generation. Two independent invariants, two constraints |
| An application-level "is this resource free?" check before insert | A read-then-write race with no arbiter. The database decides, exactly as ADR-024 already settled for waitlist offers |
| Cascading location closure into future resource assignments | Lets an administrative change silently mutate booking facts customers hold. §6.6 blocks instead |
| Class-level `@ResolveOwner`, or repairing `OwnershipGuard` inside this family | The guard reflects the handler only, so the class form is absent-and-looking-present. Repairing it touches every controller in the platform and is not smuggled into a business story. §2.5 |
| Citing pg-mem for atomicity, isolation, locking or partial-index behaviour | It honours neither rollback nor partial unique indexes, and its own docblock forbids it |
| Citing `libs/audit`'s boot assertion as this family's audit guarantee | It covers privileged-capability mutations only, and these routes declare no capability. §7.4 |

---

## Verification strategy

Each child owns its own evidence; this table records what the *family* considers proof, so no
child substitutes a weaker artefact.

| Obligation | Proof that counts | Not accepted as proof |
|---|---|---|
| At most one vertical (§1.4) | The primary key rejecting a second row, in real PostgreSQL | A service-level check, or a pg-mem test |
| Unclassified is legal (§1.5) | Creation unchanged end to end, no row written, the absence read truthfully | A default value that "looks empty" |
| Classification authorizes nothing (§1.7) | A structural assertion that no guard, resolver, port or authorization function reads either table, plus a `clinic`-vs-`salon` equivalence test | Code review |
| Active-owner repair (§2.3) | One real-PostgreSQL spec proving soft-delete-then-recreate succeeds, two live businesses are still refused, and the dead row is unreachable through `roleFor` and `update` | A migration test alone; the authorization half is the point |
| Entity/index agreement (§2.3.2) | An assertion comparing ORM-derived schema against `pg_indexes.indexdef` in real PostgreSQL | Both suites passing separately |
| Non-enumeration (§4.6, §7.5) | Byte-identical body and status **and** a timing comparison across known / unknown / ineligible / duplicate / foreign | Identical status codes only |
| Live re-check and revocation (§4.3, §5.5) | Revoke-then-next-request, and a stale token carrying a valid claim with a revoked grant | A unit test of the verifier in isolation |
| Finance write paths refuse a grantee (§5.4) | Route by route, every write path | An inspection or a single representative route |
| #72 regression (§5.3) | The existing authorization suite passing **unchanged** | The suite passing after adjustment |
| Resource collision (§6.3) | Genuinely parallel real-PostgreSQL transactions, with a positive control proving the test can fail | Sequential inserts |
| `23P01` never escapes (§6.5) | A test asserting the refusal shape, never a `500` | The absence of an observed `500` |
| Byte-identical tables (§1.1, §3.3, §6.1) | Before/after comparison **with a non-vacuity control** | A comparison that would pass on an empty table |
| ADR-027 coverage (§7.1) | The exact-set boot assertion **plus** its negative control | A passing boot |
| Transactional audit (§7.4) | A direct rollback test in real PostgreSQL | `libs/audit`'s boot assertion |

---

## Consequences

**Positive.**

- Five stories can be implemented, reviewed and reverted independently, with the only
  cross-domain transaction in the family (#110) confined to one narrow manager-scoped port.
- Every invariant that matters is enforced by PostgreSQL — a primary key, a CHECK, a partial
  unique index, an exclusion constraint — rather than by application code that a second call site
  can forget.
- The three questions the children's issues deferred are answered before anyone writes code, so
  they are decisions rather than mid-implementation discoveries.
- The privacy-minimal invitation rule means the platform holds no data about people who have no
  relationship with it.

**Negative, disclosed.**

- **A business that genuinely is two things cannot say so.** Multi-vertical is deferred, so a
  salon that is also a clinic must pick one until a separate decision reopens it.
- **Unclassified businesses will exist indefinitely.** Any future report, facet or filter over
  verticals must treat absence as a first-class case rather than assuming coverage.
- **Reception's real job is still not delivered.** A receptionist cannot act on a practitioner's
  calendar, and the read-only half that #109 can deliver will look incomplete to a salon that
  expected the whole role.
- **`OwnershipGuard`'s handler-only reflection remains a live hazard** for the rest of the
  platform. This family avoids it by convention; it does not remove it.
- **Blocking location closure (§6.6) will occasionally be inconvenient**, requiring an
  administrator to deal with future assignments before closing a branch. That is the price of
  never letting a location change touch a booking.
- **`businesses.city_id` stays in place, deprecated but present**, for as long as it takes a
  later migration to earn its removal — a period during which two places describe location.

**Reversibility.**

- §1.4 is the smaller commitment and is forward-reversible: adding a marker column and relaxing
  the key later is an ordinary migration, once the product defines what a second vertical means.
  Removing a shipped secondary-vertical concept whose semantics were never defined is not.
- §5.4 is reversible because nothing new is derived: the enumeration can be narrowed back to
  *owned* by removing the scoped branch, and no reference ever issued changes value.
- §6.6 is reversible in the safe direction — a blocking rule can later be relaxed to a cascade
  with an explicit decision, while a cascade cannot be un-run once it has mutated bookings.
- §2.3 is not reversible piecemeal, which is exactly why its four parts are one change.

---

## Rollout and non-activation boundary

Nothing in this family is behind a rollout flag, because nothing in it changes existing
behaviour on its own: each child adds tables, routes and grants that no existing surface reads
until an owner uses them. The boundary is therefore stated as facts rather than a switch —
**a single-site, unclassified business with no locations, no resources and no scoped grants
must behave exactly as it does today on every surface**, and each child proves that with the
byte-identical comparisons §7 requires.

No commercial value, price, percentage, cutoff, retention amount, commission or settlement value
is published by this ADR. No provider, payment, deposit collection, settlement, deployment, tag
or release is activated. #42 keeps `gate:legal`, #43 keeps `gate:external`, and #47 and #99 stay
blocked.

---

## Non-goals

- Multi-entity business ownership, ownership transfer, and owner-erasure succession — the last
  of which stays open exactly where ADR-027 left it.
- Delegated receptionist mutation of another practitioner's calendar or bookings.
- Any medical, diagnostic, treatment, contraindication, medication, allergy, skin-condition or
  health-record data, and any medical authority attached to `clinic`.
- Inventory, academy and B2B/wholesale marketplace domains, and any role naming them.
- A province / district / neighbourhood hierarchy, geocoding, coordinates or addresses.
- Location- or business-owned services and availability. `provider.services.professional_id` is
  `NOT NULL` and stays so.
- Multi-resource bookings, resource calendars, capacity planning, utilisation reporting and
  overbooking rules.
- Any search facet, projection, public profile or domain event derived from a vertical, a trait,
  a location, a resource or a grant.
- Any feature entitlement, pricing, plan or capability gated on a vertical. Whether a vertical
  may **ever** gate entitlement stays explicitly open.
- Any commercial value, legal copy, real provider, deployment, tag or release.

---

## Open gates

- **What happens to a business whose owner erases their personal account.** Open since ADR-027,
  and **not** closed here. The current behaviour stands: the business row is retained and the
  erased owner's membership is set to `removed`.
- **Whether a business may ever carry more than one vertical.** A named future decision under
  `V33-DEC-032` R1.
- **Invite before signup** — persisting or notifying an invitation for a phone number with no
  account. Requires a new owner and privacy decision and its own schema. §4.6.
- **Delegated receptionist calendar mutation.** A named future story with no issue.
- **Repairing `OwnershipGuard`'s handler-only reflection.** Avoided here, not fixed; it needs its
  own change with its own platform-wide review.
