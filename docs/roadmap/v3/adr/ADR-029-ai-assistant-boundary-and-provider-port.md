# ADR-029: The AI Assistant Domain — Ownership, Provider Port, Deterministic Fallback, and Honest Provider State

**Status:** Accepted — implemented in V3.2-A to the deterministic sandbox milestone.
**Date:** 2026-08-29.
**Relates to:** ADR-011 (repository architecture — no domain imports another), ADR-019 (journey is a standalone domain, not a sub-module of AI), ADR-006 (payment provider abstraction, whose registry this one is modelled on), ADR-021 (search read model), ADR-027 (subject-data contract), ADR-028 (ambiguous verification and readiness vocabulary), `V3_DOMAIN_BOUNDARIES.md` §ai, `V3_SECURITY_MODEL.md` §5.
**Binding on:** the owner decisions `V32-DEC-001`, `V32-DEC-002`, `V32-DEC-004`, `V32-DEC-005`, `V32-DEC-008`, `V32-DEC-009`, recorded in `V3.2_DECISION_REGISTER.md` on 2026-08-29.
**Companion:** ADR-030 (the AI threat model). This ADR decides *what the domain is*; that one decides *what it must survive*.
**Does not decide:** which real AI vendor is used, whether one is reachable from Iran, what it costs, or what the platform-wide spend ceiling is. All four are external and stay open. See "What is still open".

## Context

V3 has specified an AI assistant since Phase 0 and has never had one. What it does have is a capability (`bc_use_ai_assistant`, already granted to `customer`), a typed context seam (`JourneyContextProvider.inferAiDefaults`, built in Phase 3 with no consumer), and a documented prohibition (`V3_SECURITY_MODEL.md` §5). Nothing else — no schema, no module, no port.

That absence is the opportunity this ADR spends. Every structural mistake an AI feature can make is cheap to avoid before the first table exists and expensive to unwind afterwards, and V2 made several of them:

- it kept **one conversation per user**, keyed `UNIQUE(user_id)`, so the prompt grew without bound and text typed six months ago was still being replayed to a provider today (`GAP-12`);
- it passed **the whole context object** into the provider's system prompt, so the exclusion of a customer's free-text notes was upheld by an author remembering not to include a field;
- it **substituted a local fallback implicitly** when the vendor failed, so a degraded answer and a real one were indistinguishable to the person reading them (`F-03`).

The third is the one this ADR treats as decisive, because it generalises: an AI surface fails *plausibly*. A wrong search result looks wrong. A confident Persian paragraph produced by a stub looks exactly like a confident Persian paragraph produced by a frontier model, and neither the user, the operator, nor the readiness endpoint can tell them apart unless something in the architecture is built to say so.

## Decision

### 1. `ai` is a bounded module owning an `ai` schema, and it owns nothing else

A new service at `services/ai`, tagged `scope:ai`, added to the closed `ServiceName` contract and to the Nx module-boundary matrix on the same terms as every other domain: it may depend on `scope:shared` and on no other domain, enforced by lint rather than by review.

Six tables plus an outbox, described in §4 of the V3.2-A implementation report. What matters here is the negative space:

- **No search or ranking implementation.** The candidate set comes from the existing search read model through a port. `ai` cannot rank, and there is no second relevance formula to keep in agreement with the first one.
- **No authorization system.** Ownership is derived from the authenticated session by the same guards every other route uses, and no AI route accepts an owner, customer, party, or user id in a path, query, or body.
- **No recommendation engine.** The provider *names* candidates; `ai` re-resolves each one through the catalogue port and drops everything that does not come back. What the model returned is an opinion about which ids are interesting, never a source of truth about what those ids are.
- **No mutation authority of any kind.** `V32-DEC-004`. The module writes its own conversations, messages, recommendations, consent, and usage rows. It calls no other domain's command surface, and there is no code path by which an assistant response causes a booking, a payment, a profile change, or a moderation decision.

`ai` reads no other schema. Every fact it needs from another domain arrives through a typed port implemented in the composition root, which is the only place ADR-011 permits a cross-domain read.

### 2. Journey stays outside, and this is why ADR-019 was right

ADR-019 decided that `journey` is a standalone domain rather than a sub-module of AI, and gave the reason in the schema: `beauty_profiles.notes` is customer-authored free text that must never reach a provider's prompt. Had journey lived inside `ai`, that column would sit on the same side of the boundary as the code whose entire job is to serialise context into a prompt, and the rule would be upheld by author discipline in every future edit.

This ADR is the first code to test that decision, and it holds. `ai` cannot read `journey.beauty_profiles`. It can only call a port whose return type has no string field. Adding one is a visible, reviewable act in a file that says so.

### 3. The provider is a port with a registry, and the deterministic provider is a real registered provider

```
AiAssistantProvider {
  key, displayName, mode: 'deterministic' | 'external', respondsExternally: boolean
  complete(request: AiCompletionRequest): Promise<AiCompletionDraft>
}
```

One interface, one registry (`AiProviderRegistry`), modelled directly on `PaymentProviderRegistry` including the parts that look like paranoia and are not:

- **It refuses to guess.** More than one registered provider and no `AI_DEFAULT_PROVIDER` is a refusal, not "the first one wins" — which would make the model answering customers depend on module import order.
- **It fails closed.** An unknown key, a disabled provider, or an empty registry produces a Persian refusal, never a silent substitution of some other provider.

The only provider registered in this phase is `deterministic`, and it is a **first-class registered provider with its own key**, not an implicit fallback the service reaches for when something else breaks. That is the `F-03` reconciliation, and it is the whole reason the registry exists before there is anything to register beside it.

`DeterministicAssistantProvider`:

- produces schema-valid Persian responses assembled from the typed context it was given and nothing else;
- narrates only already-curated, already-public data — it composes sentences, it does not generate claims;
- never states or implies that it is a language model, and says plainly in its own answer that it is a limited local assistant;
- reports `mode: 'deterministic'`, `respondsExternally: false`;
- needs no credential, makes no network call, and costs nothing;
- is still subject to the quota, the consent requirement, the input limits, the injection check, and the output validation — every control in the pipeline runs identically whichever provider is selected, so enabling a real provider later changes one binding and no contracts.

### 4. Provider state is reported honestly, and no code may claim production verification

`ai_provider` joins `DEPENDENCIES` in the readiness vocabulary with a row in `EXTERNAL_VERIFICATION_LEDGER` (`gap: AI-PROVIDER`, `verified: false`) and `required: false` — an assistant that cannot answer must not take an API instance out of rotation.

The state mapping is deliberately unflattering:

| Situation | Reported |
|---|---|
| No provider registered | `not_configured` |
| The enabled provider is `deterministic` | `simulated` |
| A future external provider is enabled | `configured` — settings exist, nothing was probed |

`simulated` is the load-bearing word, and it is the same word ADR-028 already made the sandbox gateway, the null SMS provider, and the in-memory search engine wear. `productionVerified` stays `false` and **cannot be set true by any code path** — not by a successful completion, not by a credential being present. It becomes true when a person records evidence in the ledger, which is a deliberate act by somebody holding it.

Two consequences follow that are worth stating because they are the point:

- **A production deployment must not silently wear the deterministic provider as though it were a verified LLM.** Selecting a provider is explicit; `AI_DEFAULT_PROVIDER` unset with exactly one provider registered resolves to that one, and the readiness surface then reports `simulated` to anybody who asks. There is no configuration in which the deterministic provider serves while readiness claims otherwise.
- **A real provider must not be enabled while the spend ceiling is undecided** (`V32-DEC-008`). That is a product gate, not a code gate, and it is recorded in the dependency ledger rather than pretended away here.

### 5. Context is typed ports, asserted by key set

Every context source is a named port with a closed return type, and the exact allow-list is `V32-DEC-005`, reproduced in the implementation report and asserted by a test that compares the *key set* of the assembled context — not its values — against a literal. A new key fails that test until somebody edits it, which is the reviewable act the whole design is trying to force.

Two rules inside that are decisions rather than mechanics:

**No generic map crosses the boundary.** No `Record<string, unknown>`, no spread of an entity, no `toJSON()`. A context object is built field by field from values whose types cannot hold prose.

**Public summaries carry allow-listed public fields only, and exclude free text even when it is public.** A professional's `bio` is public, and it is excluded, because a public string authored by one party and fed into a prompt on behalf of another is an injection surface with no compensating benefit — the assistant does not need a biography to say a professional exists, is verified, and works in this city at this price.

### 6. Re-verification is the trust boundary, and it runs after the provider, always

The provider returns candidate ids. Every one of them is re-resolved through the catalogue port, and a recommendation survives only if the record still exists, is still public, is still visible, and is not suspended or deleted. Hallucinated, foreign, malformed, and stale ids are dropped silently and counted.

Schema-validity is explicitly **not** authority. A response that parses is a response that is well-formed, and a well-formed lie is the exact failure mode of a language model. `V3_SECURITY_MODEL.md` §5 already states that the calling code, not the adapter, is the trust boundary; this makes it a step in the pipeline with a test that a provider claiming a hidden professional produces zero recommendations and one stored assistant message.

## Alternatives considered

**A `scope` column on one conversation table, serving both customer and professional modes.** Rejected, and V2's own migration records why: a professional is also a customer, so a single table keyed on "the party" needs a discriminator that every query must remember, and the first one that forgets leaks a professional's business thread into a customer's list. Professional mode, when it is approved, gets its own table keyed on the party. `V32-DEC-001` defers it entirely, so this phase creates neither the table nor the capability.

**An implicit fallback to the deterministic provider when a real one fails mid-conversation.** Rejected. A user cannot distinguish "the model is thinking less well today" from "you are now talking to a template", and neither can an operator reading a dashboard. A provider failure produces a Persian refusal that says the assistant is unavailable; the deterministic provider serves when it is the *selected* provider and at no other time.

**A shared `libs/ai-context` that every domain contributes to.** Rejected. It would become the generic-map boundary this ADR exists to prevent, one well-meaning contribution at a time, and it would invert ADR-011: domains would push data toward AI instead of AI pulling named facts through ports the composition root implements.

**Storing the raw provider request and response as domain truth.** Rejected. The prompt and the completion are transient artifacts of one vendor's API shape; persisting them would make the retention obligation vendor-shaped, would put prose in a table the export contract then has to reason about, and would create exactly the log-shaped store ADR-030 forbids. What is stored is the assistant's user-facing Persian text and the validated recommendations — the domain facts.

## Consequences

**The domain contracts survive a vendor change.** Adding a real provider is one adapter, one registry entry, one configuration value, and one ledger row. No table, no controller, no browser contract, and no test of the safety pipeline changes.

**The deterministic provider is genuinely useful and genuinely limited, and says so.** It can tell a customer which verified professionals in their city match their journey defaults and their budget, with real prices from the real catalogue. It cannot converse. Shipping it as the only provider is honest; shipping it while implying otherwise would not be.

**Nothing here closes a V3.1 blocker.** `HOSTING`, `GAP-06b`, `GAP-11`, `OPS-04`, and `THROTTLE-STORE` are untouched. `AI-PROVIDER` is a new open gap, not a closed one.

## What is still open

- **Provider selection, credentials, regional reachability, pricing, and the platform-wide spend ceiling.** All external, all recorded in `V3.2_EXTERNAL_DEPENDENCY_LEDGER.md`. A real provider may not be enabled until the ceiling exists (`V32-DEC-008`).
- **Professional mode.** Deferred by `V32-DEC-001`. No capability, no table, no route.
- **The final customer-facing disclosure copy.** Legal review is open (`V32-DEC-006`); this phase implements the evidence record and the enforcement contract, not the words.
- **The customer frontend.** Not implemented here. Claude Design synchronises against the real API first.
