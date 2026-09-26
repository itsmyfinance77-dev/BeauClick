# Design documentation status

Design artifacts and production frontend code are different sources of evidence.

## On `master`

The handoffs in this directory cover the V3.1 design baseline. They do not imply that
V3.2 AI, chat, wishlist or referral screens exist in `v3/apps/web`.

## On `design/claude-design`

The long-lived design branch contains the later contract-audited V3.2 AI, internal chat,
wishlist and referral work. It was consolidated on 2026-09-02: the V3.2-C referral
workspace is the single canonical full snapshot, while the six earlier workspace copies
remain recoverable through immutable commits listed in that branch's
`docs/design/SNAPSHOT_HISTORY.md`. Repeated fonts/uploads were removed from the branch
tip without rewriting history.

When using the branch:

1. cite both the design snapshot commit and the implementation commit it audited;
2. never infer backend or frontend implementation from a prototype;
3. do not copy an entire historical snapshot to `master`;
4. prefer the canonical corrected screen specification over an earlier ZIP/snapshot;
5. update the canonical workspace rather than adding another full sibling snapshot.

The canonical implementation surface remains `v3/apps/web`.

## V3.3 design gap (2026-09-19)

`V3.3_DESIGN_GAP_AND_HANDOFF.md` records which V3.3 surfaces have a screen specification on
`design/claude-design` and which do not, checked against all 45 screens in the canonical
snapshot rather than inferred. Four surfaces with merged, tested backends have **no design at
all** — `#42a`'s outcome-policy publication, `#42b`'s seller selection, `#42d`'s no-show
declaration and customer remedy, and `#43b-1`'s commission publication — and screen 46 needs an
amendment for the per-state funds read that `#43a` and #185 added.

It carries a self-contained Claude Design prompt for each, written against the constraints the
server actually enforces, so a design cannot be produced that the backend would refuse to
support.

## V3.3 design conformance (2026-09-21)

The design corpus was measured against `v3/apps/web` and the result is two documents
that live beside this one:

- **`V3.3_DESIGN_CONFORMANCE_AUDIT.md`** — what was found and how big it was. Nine
  findings, each with the command that reproduces it. The corpus is **5,407 lines across
  60 documents**, of which the 46 screen specs and the ten rendered `.dc.html` prototypes
  are the normative artifacts.
- **`V3.3_FRONTEND_OPEN_ITEMS.md`** — what is still open: unresolved defects, deliberate
  debt, and the remaining screens. Kept current as screens land.

Three things learned that change how this directory should be read.

**The prototypes are the design; the specs describe it.** The `.dc.html` files are
fully-styled artboards with exact values, and reading only the markdown produces a
product that matches no drawing. Implementation reads the prototype and uses the spec
for the rules the drawing cannot express.

**A prototype is evidence, not an oracle.** Measured against the code, the design's own
palette had seven pairs below WCAG AA and three colours outside sRGB; its touch-target
rule and its mobile artboards contradict each other; and three claims of "derivable from
existing routes" turned out not to be derivable. Every correction is recorded at the
point of use and pinned by a test, so a future re-sync cannot quietly undo it.

**A design that describes a field the API does not return is a backend gap, not a UI
task.** Eight such gaps are listed in the open-items document with their issue numbers.
Where one exists, the UI renders nothing and a test asserts the absence — never a
plausible-looking number.

## V3.3 dashboard design (#45) (2026-09-25)

The multi-workspace commercial and operations dashboard is designed. It is on
`design/claude-design` at **`dfa0285b8c58039416f54cfc17a02aa7f90937a3`** (#323,
reviewed by Codex at `280688c`), in the sibling pack
`docs/design/v3.3-dashboard-pack/`. It was audited against implementation commit
`2e3da4a43482680db5104c1e78dba48a8d2a18f4`. It is the design that #264, #265,
#226, #255 and #328 (the messages entry, split from #237) implement against. **Built so far:** screen 52 §2–§4, the
moderator landing, its bar and the shell guard (#264), and screen 52 §5, safe
inspection of a reported image before uphold (#265). The rest is not built.

What it adds, and where to read it on the design branch:

- **Screen 51** (`51_WORKSPACE_SHELL_AND_DASHBOARDS.md`) covers:
  - one authenticated shell whose contexts (customer, professional, business,
    finance, admin) are read from live `/v1/me` facts, never from stored
    persona types;
  - workspace switching with no pre-selection and no persisted `workspaceRef`;
  - dashboards for ten personas;
  - every money fact bound to a server field or to an explicit *unavailable*
    state;
  - seven states per surface, plus responsive, RTL and keyboard rules.
- **Screen 52** (`52_MODERATOR_LANDING.md`) is the owner-approved moderator
  landing inside the shared admin shell, and the safe media-inspection states
  (#264, #265).
- **Screen 51 §12** lists the amendments this design makes to specs 03, 13/46,
  20, 25, 27, 36 and 42. **Read it before implementing any of them.**
- **`verify/check-traceability.mjs`** checks the design against the code. It
  fails if a cited route, field or capability disappears, if a recorded
  absence stops being true, or if the prototype shows a field no route
  returns. Its paths are canonical on every platform, and it was run on Linux
  and, by the reviewer, on Windows.

It **renders, rather than invents**, facts the API does not have:

- reception has no role (`V33-DEC-030`, `V33-DEC-033` R1);
- disputes and appeals have no route (#162, #180);
- there is no seller-owed receivable (#177);
- two gaps have no issue yet: a seller read for the booking-credit balance, and
  a read for entitlement usage. Both are recorded in
  `V3.3_FRONTEND_OPEN_ITEMS.md` §4.
