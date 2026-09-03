# BeauClick design branch

This branch preserves design evidence separately from production frontend code.

## Canonical current workspace

[`v3.3-a-commercial-catalogue-workspace-snapshot/`](v3.3-a-commercial-catalogue-workspace-snapshot/)
is the single current full workspace snapshot. It includes the corrected V3.2
AI, chat, wishlist and referral material plus the V3.3-A administrator
commercial-catalogue specification and Pro/Admin prototype §19. Its manifest
identifies the implementation commit each pass audited.

`MANIFEST.md` is the authoritative pass-by-pass sync record inside the snapshot.
The nested `docs/design/REPORT.md` is the preserved initial V3 design report; it
is historical and must not be read as the current workspace status.

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
