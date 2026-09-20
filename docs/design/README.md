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
