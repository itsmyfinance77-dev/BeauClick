# Runbook — rollback

## Status

**Not exercised.** It needs a host, and `HOSTING` is open. The command shape is
real; the judgement below is the part that matters and is not automatable.

---

## Answer this before rolling anything back

> **Did the deploy you are reverting apply a migration?**

This is the whole runbook. Rolling code back is one command. Rolling code back
*past a migration that has already run* leaves the previous version running
against a newer schema, and that is frequently a worse failure than the one you
are escaping — with the added property that the second failure is now in code
nobody is currently looking at.

```bash
# What ran, and when.
psql "$DATABASE_URL" -c \
  "SELECT filename, applied_at FROM public.schema_migrations ORDER BY applied_at DESC LIMIT 10"
```

### Case A — no migration in the bad deploy

Roll back freely. Re-run **V3 CD** with `image_tag` set to the previously
deployed SHA. The `image` job skips the build and redeploys the existing image
rather than rebuilding from source — rebuilding would produce a *different*
image from the same commit (a newer base image, a different transitive
dependency) and therefore not the thing that was previously running.

### Case B — a migration ran, and it is backward-compatible

Roll the code back the same way. Leave the migration in place.

Backward-compatible means the previous version can run against the new schema:
an added nullable column, a new table, a new index, a widened type. This
project's migrations are additive by convention, so this is the common case.

Do **not** attempt to reverse it. There is no `down` migration in this codebase
and that is deliberate: a down migration is code that has never run, written
against a schema state nobody has, executed under time pressure on the one
occasion it matters.

### Case C — a migration ran and is NOT backward-compatible

**Do not roll back.** Fix forward.

A dropped column, a narrowed type, a renamed table, or a new `NOT NULL` without
a default means the old code cannot run against this schema at all. Reverting
the image produces immediate, total failure instead of whatever partial failure
you have now.

Deploy a fix on top instead. If the incident is severe enough that the service
must stop, stop it deliberately rather than reverting into a guaranteed crash
loop.

### Case D — the financial schema is involved

Escalate. Do not roll back without a second person.

`financial.ledger_entries` is append-only **by grant**, not by convention
(ADR-009 / ADR-017). Nothing in the application can delete a ledger entry, so
whatever was written during the bad deploy is still there and is still correct
as a record of what happened. A correction is a compensating entry, never a
deletion — and the deploy pipeline is not the tool for it.

---

## After any rollback

1. Confirm what is running:

   ```bash
   curl -s "$PUBLIC_API_BASE_URL/health/ready" | jq '.status, .configuration.valid'
   ```

2. Re-verify the role contract. A rollback does not touch grants, but this is
   cheap and the failure it catches is silent:

   ```bash
   DATABASE_URL="$APP_DATABASE_URL" pnpm verify:roles
   ```

3. Check the payment metric before declaring the incident over:

   ```bash
   curl -sH "authorization: Bearer $METRICS_AUTH_TOKEN" "$PUBLIC_API_BASE_URL/metrics" \
     | grep payment_verifications
   ```

   A non-zero `outcome="unresolved"` count during the incident window means
   payments whose result nobody knows. Those need
   [PAYMENT_INCIDENT.md](PAYMENT_INCIDENT.md), not a rollback.

---

## Why rollback is not automatic

`V3_INFRASTRUCTURE_PLAN.md` §6 asks for automatic rollback on a failed
post-deploy health check, and the CD workflow deliberately does not do it — it
prints the command and points here instead.

An automatic redeploy of the previous image after a forward migration has
already applied is Case C executed by a robot, at the moment when a human is
least able to catch it. The health check is the right trigger; the decision is
not one a workflow can make, because it depends on what the migration did.

This can be revisited once migrations carry a machine-readable
backward-compatibility marker. They do not today, and inventing one to justify
an automated rollback would be building the mechanism before the fact it
depends on.
