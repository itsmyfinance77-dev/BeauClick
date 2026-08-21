# ADR-019: Beauty Journey's Domain Boundary

**Status:** Accepted — implemented in Phase 3.
**Date:** 2026-08-21.
**Closes:** GAP-29.

## Context

`GAP-29` recorded that Beauty Journey — a real, fully-built V2 domain with its own tables, its own REST controller, and seven routes — had **no V3 service-boundary assignment anywhere** in the Phase 0 corpus. It was absent from `V3_ARCHITECTURE_PLAN.md`'s twelve-service list, from `V3_MIGRATION_MATRIX.md`, and from `V3_API_CONTRACTS.md`.

The gap register's own note is unusually candid about how it was closed the first time: the Phase 0 blueprint named `journey` as a top-level domain **by direction**, and the register says so explicitly — "this settles the boundary question by direction rather than by the independent evidence-based review this row's original preliminary recommendation said it needed."

That earlier preliminary recommendation was to **fold Journey into ai-service**. So the placement was directed one way while the only recorded analysis pointed the other. Phase 3 is where the code gets written, so this is where the question actually has to be answered on evidence.

## Decision

**Journey is a standalone domain module, not a sub-module of AI.** This confirms the directed placement — but on grounds that are now demonstrable rather than assumed.

The decisive evidence is a single column: `journey.beauty_profiles.notes`.

`notes` is short, customer-authored free text. V2's own `JourneyContextProvider` docblock states the rule it must obey and why: the notes must never reach an external AI provider's prompt, because `AnthropicProvider` serializes the whole context object into its system prompt. V2 honoured that rule by hand-building the returned array and remembering not to include the field.

If Journey lived inside ai-service, that data would sit on the same side of the module boundary as the code whose entire job is to assemble prompts. The rule would then be upheld by author discipline on every future edit, forever — and "we remembered not to include the field" is precisely the kind of guarantee this project has repeatedly found to fail (GAP-01's convention-only ledger immutability, GAP-08's unused ownership helper).

Owned separately, an AI module **cannot read the column at all**. Its only route into Journey is `JourneyContextProvider.inferAiDefaults()`, whose return type is:

```ts
interface JourneyAiContext {
  specialtyIds?: string[];
  cityId?: string;
  budgetToman?: number;
}
```

Every field is a structured identifier or a number. **There is no string field of any kind.** Passing notes into a prompt would require adding one — a visible, reviewable act — rather than an accidental object spread.

The same reasoning extends to goals: `BeautyGoalCreated` carries the goal's structured intent (specialty, city, budget, target date) and deliberately **not its title**, because a title like "آماده شدن برای عروسی خواهرم" is equally customer-authored prose.

## Consequences

- **Positive:** the privacy rule is enforced by a type rather than by memory, and is covered by tests that assert the notes and the goal title appear in neither the AI context nor any event payload nor the timeline.
- **Positive:** the timeline stopped being a cross-domain read. V2 composed it at read time from `wp_bc_events` and `wp_bc_bookings` — two other plugins' tables — and its own docblock records the workaround that forced (booking events carried no `actor_id`, so the composer had to fetch the customer's booking ids first and match against that set). V3's timeline is a read model journey **owns**, written by event handlers. Journey queries no other schema.
- **Negative:** a genuinely new module, with its own schema, migrations, and outbox, for a domain that is small today.
- **Negative:** the AI integration is now an explicit call across a boundary rather than a direct read. That is the point, but it does mean an AI feature wanting richer context must extend the contract rather than reach for the data.

## Alternatives considered

- **Fold into ai-service** (the original preliminary recommendation). Rejected on the `notes` argument above. Journey is also not AI-specific: the profile, goals, and timeline are a customer-facing product surface in their own right, and the AI integration is one consumer of them.
- **Fold into a customer-profile module.** There is no such module in V3, and inventing one to host Journey would be a larger boundary decision made for a smaller reason.
- **Keep the timeline as a read-time composition over other domains' tables** (V2's shape). Rejected: it is a direct module-boundary violation under ADR-011, and V2's own experience shows it forces workarounds when the source tables are not shaped for the query.
