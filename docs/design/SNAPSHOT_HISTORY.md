# Design workspace snapshot history

Historical snapshots remain recoverable by immutable Git commit. This index
replaces repeated full directory copies at the branch tip; it does not delete or
rewrite their history.

| Snapshot | Commit | Date | Current-tree status |
|---|---|---|---|
| Phase D | `f60e91e1879dfd0e14cd9bf8a5a5d607b6fb3bcc` | 2026-08-29 | Historical; use commit |
| Phase E | `e3950620f097196329b543b1a3ec74a9edf1391b` | 2026-08-29 | Historical; use commit |
| Phase F | `4b40b9055e909af5cdf7018183d5a57caeb4f1f6` | 2026-08-29 | Historical; use commit |
| Phase F closure | `66171d676be98c8c2faf9fe655cdb88de2eed268` | 2026-08-29 | Historical; use commit |
| V3.2-B chat | `c25e477b7dc3ba458ce4b8d3372fd5efb75dd639` | 2026-08-30 | Historical; use commit |
| V3.2-C wishlist | `c36b5d32ca3ecf24bfdde488e08aec38ed08e5e0` | 2026-08-31 | Historical; use commit |
| V3.2-C referral | `201a7f453adbc58b4ed17f514bf1de8659174317` | 2026-09-02 | Historical; use commit |
| V3.3-A commercial catalogue | `d2f51c34739f35ea5435f363f484dff0e23d7dbb` | 2026-09-03 | Canonical current workspace |

Examples:

```bash
git show f60e91e:docs/design/phase-d-workspace-snapshot/01_SEARCH.md
git archive --format=zip --output=phase-e-design.zip e3950620 -- docs/design/phase-e-workspace-snapshot
```

The root handoff files and `archive/` are retained because they are small,
directly named references rather than full workspace copies.
