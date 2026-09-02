# Archived documents

Documents here described a state of the project that no longer exists. They are
kept because they are the historical record of a decision or a setup that people
may still need to read, not because they are current guidance.

| File | What it was | Superseded by |
|---|---|---|
| [README-v2-wordpress.md](README-v2-wordpress.md) | The repository README while V2 (WordPress + WooCommerce, `wordpress/` and `app/`) was the line of development. Its setup instructions build the frozen V2 stack, not the V3 platform. | [`README.md`](../../README.md) at the repository root |

## Nothing was deleted

The V2 source tree itself is still present and unchanged under `wordpress/`,
`app/`, `shared/` and `bin/`. Archiving the README moved one file; it removed no
code, no history and no tag. Every V1/V2 release tag (`v1.0.0` … `v2.4.1`) is
untouched.

See [`ADR-001`](../roadmap/v3/adr/ADR-001-wordpress-exit.md) and
[`WORDPRESS_EXIT_MATRIX.md`](../roadmap/v3/WORDPRESS_EXIT_MATRIX.md) for why V2
was replaced and what WordPress was actually doing for the product.

## A note on the archived README's own links

`README-v2-wordpress.md` is preserved **byte for byte** as it stood at the root,
so its relative links are still written for the repository root and do not
resolve from this directory. Read them against the root:
`docs/business/`, `docs/architecture/ARCHITECTURE_PROPOSAL.md` and
`wordpress/router.php` all still exist there. One link was already stale before
the move: `docs/design/DESIGN_HANDOFF.md` now lives at
[`docs/design/archive/DESIGN_HANDOFF.md`](../design/archive/DESIGN_HANDOFF.md),
and the current design baseline is
[`docs/design/V3.1.0_CLAUDE_DESIGN_HANDOFF.md`](../design/V3.1.0_CLAUDE_DESIGN_HANDOFF.md).

Fixing those links inside the archived file would change the artefact this
directory exists to preserve, so they are documented here instead.
