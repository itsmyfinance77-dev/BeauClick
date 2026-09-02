# BeauClick design branch

This branch preserves design evidence separately from production frontend code.

## Canonical current workspace

[`v3.2-c-referral-workspace-snapshot/`](v3.2-c-referral-workspace-snapshot/) is
the single current full workspace snapshot. It includes the corrected V3.2 AI,
chat, wishlist and referral specifications and prototypes through customer §20.
Its manifest identifies the implementation commit each pass audited.

The snapshot is **not** a production frontend implementation. The executable UI
source of truth remains `v3/apps/web` on `master`.

## Historical snapshots

Earlier complete workspace copies were removed from the branch tip on
2026-09-02 because they repeated the same fonts, uploads, support runtime and
prototype files. Their immutable commits remain available and are indexed in
[`SNAPSHOT_HISTORY.md`](SNAPSHOT_HISTORY.md); no history was rewritten.

When another design pass lands:

1. audit against an exact implementation SHA;
2. update the canonical workspace instead of adding another full sibling copy;
3. preserve the previous state with its Git commit, not a duplicate asset tree;
4. update `MANIFEST.md`, this file and `SNAPSHOT_HISTORY.md`;
5. state explicitly which screens are prototypes and which exist in
   `v3/apps/web`.
