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
