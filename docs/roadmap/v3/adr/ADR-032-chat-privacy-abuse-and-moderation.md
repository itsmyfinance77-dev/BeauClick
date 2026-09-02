# ADR-032: Chat Privacy, Abuse, and the Moderation Boundary

**Status:** Accepted — implemented in V3.2-B to the externally-independent backend milestone.
**Date:** 2026-08-30.
**Relates to:** ADR-027 (subject-data contract — this ADR deliberately takes no exception to it), ADR-031 (the chat domain and eligibility), ADR-029/ADR-030 (the AI domain, which chat is walled off from), `V3_SECURITY_MODEL.md` §§3–4, `libs/audit`'s boot-time enforcement, `media.abuse_reports` as the report model being mirrored.
**Binding on:** `V32-DEC-013`, `V32-DEC-014`, `V32-DEC-015`, closed by the product owner on 2026-08-30.
**Companion:** ADR-031.

## Context

Chat introduces the platform's second store of private, subject-authored prose, after the AI assistant. It differs from the first in one way that changes every privacy answer: **there are two people in it.**

That single fact is why `V32-DEC-013` was the hardest decision in V3.2-B. Every other module's erasure question is "what do we do with this person's data"; here it is "what do we do with this person's data when a second person has a legitimate interest in the same rows".

Three existing mechanisms are being reused rather than reinvented, and naming them is most of this ADR's engineering content: `media.abuse_reports` for the report lifecycle, `libs/audit` for moderation attribution, and `libs/ownership`'s single `NotFoundOrNotYoursException` for indistinguishable refusals.

## Decision

### 1. Erasure destroys the erased subject's prose — ADR-027 is not excepted

ADR-027 states the platform rule plainly: *"every module destroys free text the SUBJECT authored, because prose is identifying in a way an id is not."*

Engineering's decision packet recommended breaking that rule for chat — retaining an erased customer's messages so the professional keeps a complete business record — and flagged it as an exception requiring legal sign-off. **The owner rejected that and chose the consistent option.** This ADR records the consistent model:

- **Prose authored by the erased subject is destroyed.**
- Where sequence and thread coherence require it, a **neutral structural placeholder** remains. It contains no original body, no excerpt, no searchable text, and nothing from which the original could be reconstructed. It is a gap with a sequence number, not a redaction of a known string.
- **Messages authored by the surviving counterparty are preserved**, unchanged. The professional keeps their own words.
- The erased identity is **tombstoned** as «کاربر حذف‌شده» through the existing `tombstoneFor()` helper.
- **No anonymisation claim is made anywhere**, because no subject-authored prose is retained. This is the point of the choice: the weakest claim the platform has to defend is the one it does not have to make.

**Why this is better than it first looks.** The rejected option's appeal was thread coherence — a conversation where one side vanished reads as though nobody spoke. The placeholder recovers most of that: the counterparty sees their own messages in order, with visible gaps where the other person's words were, attributed to a deleted user. What they lose is content they were never entitled to keep once its author withdrew it. What the platform gains is that "delete my account" means it.

**Retention:** 24 months from `chat.conversations.last_message_at`, swept by **hard delete and cascade** of the whole expired conversation. The conversation is the retention unit, not the message — sweeping individual messages would leave threads with holes in the middle, which is the failure the placeholder exists to make rare, not common.

**Export:** the subject's own **still-existing** authored messages plus permitted conversation metadata. "Still-existing" is load-bearing: a message the subject deleted, or one swept by retention, is not resurrected for an export.

**Blocks and throttle counters** belonging to the erased subject are destroyed — a block is a live preference, not a record about anyone else, and a counter is bookkeeping.

**Moderation reports** retain the minimum decision record with the reporter tombstoned, consistent with the admin audit log's existing position: a privileged action must stay attributable, or the audit trail is defeated by the subject of the complaint closing their account.

### 2. Blocking is directional in the record and mutual in effect

Stored as `(blocker_user_id, blocked_user_id)` with a unique index. Sending is refused **for both parties** while a block exists.

**Why the record is directional.** Moderation needs to answer "who blocked whom", and a symmetric row cannot.

**Why the effect is mutual.** A one-way block leaves the blocker free to keep messaging someone who has signalled they want no contact. That is the harassment case with the roles reversed, and it is a real pattern rather than a hypothetical.

**The blocked party is never told they were blocked.** They are told only that sending is unavailable — the same closed refusal vocabulary every other unavailable-send reason uses. A block notification is an invitation to retaliate through a channel the platform does not control.

**History stays readable** on both sides. A block is a preference about the future; destroying the past would let one party unilaterally erase a record the other may need.

**Only the blocker may unblock.** Unblocking restores sending subject to the ADR-031 send window, which may itself have closed in the meantime.

### 3. Reporting mirrors `media.abuse_reports`, with one addition

Same lifecycle (`open` → `upheld` | `rejected`, both terminal), same `decided_by` / `decided_at` / `decision_reason` shape, same partial-unique-index trick for duplicate suppression.

- **Reasons:** `harassment`, `spam`, `scam_or_fraud`, `explicit`, `personal_data`, `off_platform_payment`, `other`.
- **`off_platform_payment` is the addition.** Taking payment outside the platform is a chat-specific harm with direct financial consequences for the customer, and folding it into `other` would make the single most actionable category invisible in the queue.
- **A report anchors to a specific message.** Without an anchor a moderator reads a thread looking for the complaint; with one they read the complaint.
- **At most 5 new reports per reporter per rolling 24 hours**, and **one open report per (reporter, conversation)** enforced by a partial unique index rather than an application check — the same mechanism, and the same reasoning, `media.abuse_reports` records.
- **The optional note is capped at 500 Unicode code points** and is moderation prose: it never enters an event, a notification, an analytics dimension, a metric label, or a log line.

**Upheld actions:** warn the sender, permanently close the conversation for sending, or restrict the sender's platform-wide chat sending.

**Moderators cannot edit or delete participant messages.** Deleting would destroy the evidence the decision rests on and hand a moderator a power neither participant has. Moderation restricts *access and future sending*; it does not rewrite what was said.

### 4. Privileged access begins at a report id and nowhere else

`bc_moderate_chat`, new, added to `PRIVILEGED_CAPABILITIES`. That list confers two things and both are needed here: a **live revocation re-check** on every request, so a moderator whose access was withdrawn loses the surface immediately rather than at token expiry; and `libs/audit`'s **refusal to boot** when a mutation gated on it declares no audit action.

Default holders: `moderator` and `administrator`. **Not** `platform_operator` — reading a private conversation and operating the platform are different privileges, and `platform_operator` exists precisely to be the narrower tier.

- **Entry is a report id.** There is no route taking a conversation id, a user id, a professional id, or a business id. The absence is the control.
- **At most 50 messages**, centred on the reported message where possible. A conversation may span two years and cover a customer's cosmetic and medical history; a moderator judging one complaint needs the exchange around it, not a life story.
- **Access lasts while the report is `open`, plus 30 days after its decision.** Appeals and repeat-offender checks need the record briefly. Permanent access would turn every resolved report into a standing read grant, and the queue only grows.
- **Reading is audited, not only acting.** Opening the reported window writes an audit row. A privilege that leaves no trace when exercised is the one most worth tracing.
- **No browsing, no search, no sending, no impersonation, no editing, no deletion.** Impersonation stays `RETIRED` in every alternative.

### 5. Human chat is not AI context, and there is no port through which it could become one

`V3.2_PRODUCT_ROADMAP.md` §4 states it as a non-goal and the capability catalog lists automatic use of human chat as AI context as `RETIRED`.

The enforcement is structural: **`chat` exposes no context port, and `ai`'s context boundary is a closed three-key type whose key set is asserted against a literal.** Adding chat to AI context would require a new port in `chat`, a new key in `AiCustomerContext`, and an edit to a test that exists to fail. That is three visible acts, which is the intended amount of friction.

## Alternatives considered

**Retaining the erased subject's prose (the packet's recommendation).** Rejected by the owner. It would have been the platform's first exception to ADR-027, and it would have needed legal sign-off that does not yet exist — which would have made the backend milestone depend on an external gate for no engineering reason.

**Destroying the entire conversation on either party's erasure.** Rejected. One person closing their account would destroy a professional's business record.

**Reporting without a moderation queue.** Explicitly rejected as an option. A report button that files into nothing collects a user's expectation of a response and discards it, which is worse than having no button.

**Widening `bc_moderate_media` instead of adding a capability.** Rejected. Reviewing a private conversation and taking down a public portfolio image are different privileges; conflating them would grant every media moderator a private-message read.

**Time-bounded access to any conversation on a stated purpose.** Rejected as the wrong default for a first release. It is easy to add later and very hard to take away once support workflows depend on it.

## Consequences

**Chat introduces no new legal gate on the backend.** Because §1 takes no exception to ADR-027, the approved disclosure copy remains a public-release gate and stops blocking implementation.

**Some threads will read as one-sided after an erasure.** Named, accepted, and mitigated by the placeholder rather than pretended away.

**The moderation surface is small enough to reason about**: three routes, one entry point, one capability, every read audited.

## What is still open

- **Approved customer-facing disclosure copy** — a public-release gate.
- **The V3.3-C staff role matrix**, which owns any widening of business-inbox access.
- **Attachments and push** — `CHAT-ATTACHMENT-STORAGE` and `CHAT-PUSH`, both untouched by this milestone because neither feature is built, not even behind a flag.
