# BeauClick Backlog and Story-Point Operating Model

**Status:** ACTIVE from V3.2-C onward. V3.2-A and V3.2-B predate this system and
are not retroactively pointed; retroactive estimates would contaminate velocity.

## 1. Source of truth

GitHub Issues are the authoritative backlog. Roadmap documents explain direction;
issues describe accepted work. A roadmap paragraph is not implementation authority
until it has been refined into an issue with explicit acceptance criteria.

The hierarchy is:

```text
Roadmap -> Milestone/Phase -> Epic -> Story | Bug | Decision | Blocker
```

Epics group outcomes and never carry story points. Stories, bugs, decisions, and
bounded enabling work may be pointed. Tasks that are inseparable from a story
belong in that story's checklist rather than becoming administrative issues.

## 2. Required classification

Every active delivery issue carries:

- exactly one `type:*` label;
- exactly one `priority:*` label;
- exactly one `status:*` label while open;
- one phase milestone.

Every pointable item (story, bug, decision, or bounded enabling work) carries
exactly one `sp:*` label before it becomes `status:ready`. Epics and `type:meta`
governance issues are deliberately unpointed; meta issues may also be unscheduled.

External, legal, evidence, or product gates additionally carry a `gate:*` label.
Engineering and design work use `track:engineering` and `track:design` when the
distinction is material.

## 3. Workflow states

| State | Meaning | Exit condition |
|---|---|---|
| `status:proposed` | Captured, not yet accepted | Owner/product triage |
| `status:decision` | A binding choice is required | Decision recorded with approver |
| `status:ready` | Definition of Ready is satisfied | Work starts on a scoped branch |
| `status:in-progress` | Active implementation or design | PR/design review begins |
| `status:review` | Awaiting review and required checks | Acceptance and green checks |
| `status:blocked` | Cannot progress without a named gate | Gate is genuinely cleared |

Closing an issue means Done. Labels such as `status:review` must be removed when
the issue is closed; the dashboard treats GitHub's closed state as authoritative.

## 4. Definition of Ready

A story is Ready only when:

- the user/business outcome is clear;
- acceptance and rejection criteria are testable;
- product, legal, privacy, and ownership decisions are either closed or named as
  explicit blockers;
- dependencies and non-goals are recorded;
- the story is small enough to score 13 points or fewer;
- one story-point label is assigned;
- required design or backend contract inputs are linked.

An item larger than 13 points must be split. `sp:21` exists only as a warning
label for an epic-sized item awaiting decomposition; it must not enter a cycle.

## 5. Story-point scale

Story points measure relative effort, complexity, uncertainty, integration risk,
and verification burden. They are not hours and are never used to rank people or
agents.

| Points | BeauClick calibration |
|---:|---|
| 1 | Trivial, isolated, obvious verification |
| 2 | Small bounded change or decision |
| 3 | Several states or one modest integration |
| 5 | Cross-file/domain change with meaningful tests |
| 8 | Full bounded feature slice with persistence/security/design implications |
| 13 | Large but coherent outcome with substantial concurrency/privacy risk |
| 21 | Too large; split before Ready |

Estimates are assigned during refinement and may change before work starts. Once
work is in progress, a changed estimate requires an issue comment explaining the
new information. Scope must not be hidden by silently increasing points.

## 6. Definition of Done

Done requires all applicable evidence:

- acceptance criteria pass;
- positive, negative, adversarial, and concurrency tests are proportional to risk;
- required migrations pass from clean and already-applied states;
- privacy, ownership, capability, audit, and event boundaries are verified;
- documentation and the roadmap reflect the implementation;
- design is synchronised to the real contract when the story requires it;
- the final PR revision has all required CI checks green;
- the PR is squash-merged and contains no unrelated or external-gate claims;
- remaining non-goals and blockers are recorded rather than implied complete.

Code written, a local test pass, or a pushed branch alone is not Done.

## 7. Planning and metrics

Milestones represent product phases, not arbitrary deadlines. The live dashboard
reports:

- completed points / total pointed scope (burn-up);
- ready, active, review, and blocked points;
- unestimated open items;
- recent completed points by calendar week.

Velocity becomes a forecasting input only after at least three completed cycles.
It is never a commitment and never a performance target. Forecasts must show
blocked and unestimated work separately.

The official completion percentage for a milestone is:

```text
closed pointed issues / all pointed issues in the milestone
```

Epics and unestimated work are excluded from the percentage but displayed as
data-quality warnings. This prevents a large unknown backlog from masquerading
as measurable progress.

## 8. Priority

- `priority:p0`: active incident, security exposure, or release-stopping defect;
- `priority:p1`: next critical product outcome or serious risk;
- `priority:p2`: planned normal work;
- `priority:p3`: optional/deferred improvement.

Priority does not override a blocker. A P0 with an external gate remains blocked
until the gate is genuinely cleared.

## 9. BeauClick-specific controls

- External dependencies never count as delivered because a local adapter exists.
- AI, payment, SMS, storage, legal, hosting, and banking gates retain their
  existing readiness language.
- Claude Code works from accepted stories on short-lived branches and pull
  requests; no direct push to `master`.
- Claude Design cites the exact backend contract baseline and has its own design
  story when a synchronisation is required.
- Bugs discovered during a story are recorded as separate issues only when they
  survive beyond the story or materially change scope. Otherwise they are named
  in the story and PR evidence.
- A release tag, deployment, provider activation, or credential change always
  requires separate authority regardless of points or CI state.

## 10. Governance

The product owner approves scope and product decisions. Engineering owns technical
decomposition and estimates, while explaining uncertainty. Legal/external gates
remain with their named approvers. The project manager maintains backlog hygiene,
facilitates refinement, and reports facts without converting unknowns into false
percentages.
