# Operational runbooks

Written during V3.1 Phase F, before there is a host to run them against.

That ordering is deliberate rather than premature. `V3_INFRASTRUCTURE_PLAN.md`
§9 asks for a restore runbook that has been **tested**, and the point it makes
about backups generalises to every procedure here: a runbook that has never
been executed is a document, not a capability. So each of these is written
around a command that exists and can be run today, and each states plainly
which of its steps have actually been exercised and which are waiting on the
`HOSTING` decision.

| Runbook | What it covers | Exercised? |
|---|---|---|
| [DEPLOY.md](DEPLOY.md) | First-time provisioning and a routine deploy | Partly — every command except the deploy itself |
| [ROLLBACK.md](ROLLBACK.md) | Reverting a bad deploy, and the migration question that comes first | No — needs a host |
| [RESTORE.md](RESTORE.md) | Restoring the database from a backup | Mechanism yes, on a disposable target; the real drill no |
| [SECRET_ROTATION.md](SECRET_ROTATION.md) | Rotating each secret without locking anyone out | Partly — the contract is enforced in code |
| [PAYMENT_INCIDENT.md](PAYMENT_INCIDENT.md) | Unresolved verifications, duplicate charges, amount mismatches | The code paths yes; a real gateway no |

## The honest status of all of this

None of these runbooks closes a gap. They remove the excuse that the work is
undocumented; they do not perform it. The External Enablement Gate
(`V3.1_EXTERNAL_ENABLEMENT_STRATEGY.md` §4) is unchanged, and every item in it
is still open.

## Conventions

- **Every command is copy-pasteable and real.** Nothing here is pseudocode. If
  a step cannot be written as a command yet, it says so and names why.
- **No secret appears in any of these files.** Variable NAMES only. The
  authoritative list of what each secret protects is `SECRET_CONTRACT` in
  `v3/apps/api/src/config/env.validation.ts` — code rather than prose, because
  a list in a document drifts from the code that reads it.
- **Where a step is destructive, it says so before the command, not after.**
