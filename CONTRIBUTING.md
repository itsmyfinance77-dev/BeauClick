# Contributing to BeauClick

BeauClick uses a pull-request-first workflow. `master` represents the latest
reviewed, integration-tested state; it is not a working branch.

Product work is also backlog-first. Every implementation pull request must
reference an accepted GitHub issue carrying the appropriate type, milestone,
priority, status, and story-point labels. The operating model is documented in
[`docs/product/BACKLOG_OPERATING_MODEL.md`](docs/product/BACKLOG_OPERATING_MODEL.md).

## Required workflow

1. Fetch `origin` and verify the intended baseline before changing files.
2. Create one scoped branch per task. Accepted prefixes are `feature/`, `fix/`,
   `docs/`, `chore/`, `design/`, and `codex/`.
3. Keep unrelated user changes and untracked files out of the branch.
4. Commit in reviewable stages when a change spans decisions, schema, code,
   tests, and documentation.
5. Push the branch and open a pull request against `master`.
6. Link the accepted backlog item in the pull request. A PR must not silently
   widen the story's acceptance criteria or close an unresolved product decision.
7. Run the checks appropriate to the change. Any code, schema, build, workflow,
   or dependency change must pass the complete V3 CI pipeline.
8. A failed, cancelled, pending, or skipped required check is not approval to
   merge. Repair the same branch and let CI run again.
9. Review the final diff and confirm that the PR contains no credentials,
   generated secrets, unrelated files, or accidental external integrations.
10. Squash-merge only after the required checks are green. Close the linked issue
   only when its Definition of Done is satisfied, then delete the short-lived
   branch after merge.

Direct pushes to `master` are prohibited by project policy. GitHub branch
protection is not currently configured: the repository is public, but no branch
protection rule or ruleset protects `master` as of 2026-09-02. The pull-request policy
workflow checks branch names; it is not a substitute for GitHub merge enforcement.
Until an administrator enables a ruleset, the prohibition above remains a mandatory
human/agent gate. Repository visibility and branch protection are separate decisions;
visibility must never be changed as a workaround for governance.

## CI meaning

- Green means the checks defined for that revision passed.
- Red means the revision must not be merged.
- Cancelled is not equivalent to green.
- A later green run does not rewrite an earlier result; it proves only the later
  revision.

The full V3 pipeline covers static checks, fast tests, real PostgreSQL,
OpenSearch and object-storage integration tests, migration idempotency, role
contracts, restore rehearsal, and the zero-skipped-suite assertion.

## Design work

Claude Design artifacts remain on the long-lived design branch. A design sync
must cite the implemented contract baseline it was audited against. Design
artifacts reach `master` only through a separate reviewed pull request when the
repository actually needs them there.

## Release and external systems

A green PR does not authorize a release tag, production deployment, credential
change, paid provider, public repository, or external integration. Each still
requires its own explicit approval and documented gate.
