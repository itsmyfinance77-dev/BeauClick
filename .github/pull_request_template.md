## Outcome

Describe the user-visible or engineering result. Lead with what changed and why.

## Scope

- [ ] The PR has one coherent purpose.
- [ ] Unrelated local or user-owned changes are excluded.
- [ ] No credential, secret, production configuration, or unapproved external integration is included.

## Evidence

List the commands, test counts, migration results, screenshots, or contract evidence relevant to this change.

- [ ] Relevant local checks pass.
- [ ] Required GitHub Actions checks are green (not pending, cancelled, skipped, or failed).
- [ ] New behaviour has positive, negative, and adversarial coverage proportional to its risk.
- [ ] Database migrations were tested from clean and already-applied states, when applicable.
- [ ] Privacy/ownership/authorization boundaries were rechecked, when applicable.
- [ ] Documentation and design status match the implemented contract.

## Review boundaries

Record anything deliberately not built, any external/product/legal gate still open, and any follow-up that must not be inferred as complete.

## Merge gate

- [ ] Final diff reviewed against the target branch.
- [ ] CI is green on the final PR revision.
- [ ] Squash merge is appropriate and the resulting commit message is accurate.
- [ ] No release tag or deployment is implied by this merge.
