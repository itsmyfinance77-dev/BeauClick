# Runbook — backup and restore

## Status

**The mechanism is exercised. The drill is not.**

`pnpm restore:rehearse` runs the whole loop against a disposable database on
every CI build, and locally during V3.1 Phase F it moved 71 tables and 37
migrations and re-verified all 44 role-contract checks on the restored copy.

`V3_INFRASTRUCTURE_PLAN.md` §9 asks for something this is not: a real backup of
real production data, restored into a clean target, with the restored system
verified. That needs a host. It is open, and a green rehearsal must never be
cited for it.

> **a backup that has never been restored is not a verified backup**
> — `V3_INFRASTRUCTURE_PLAN.md` §9

---

## Taking a backup

```bash
BACKUP_SOURCE_URL="$ADMIN_DATABASE_URL" BACKUP_DIR=/var/backups/beauclick pnpm backup
```

Produces the dump plus a manifest beside it recording the sha256, the byte
length, the server version, every applied migration, and per-table row counts.

Two things it deliberately does not do:

- **It is not a schedule.** Daily snapshots and WAL archiving are a property of
  the managed provider, and no provider has been selected (`HOSTING`). Wiring a
  cron here would be inventing that decision. What this removes is the excuse
  that taking a backup is manual work.
- **It does not put a connection string in the manifest.** A manifest travels
  with the dump into whatever storage holds it; a URL there hands out the host,
  the role, and the password along with the data.

Run it as an admin role, not the application role. `financial.*` is unreadable
by the application role by design, and a backup taken as that role records
those tables as `-1` — which restores and verifies consistently, but tells you
nothing about whether the ledger came back.

---

## Rehearsing a restore

Safe to run any time. It creates and drops a database named
`beauclick_restore_rehearsal` — a fixed name, deliberately not configurable,
because this script DROPS it twice and an environment variable there is one
typo away from dropping something real.

```bash
REHEARSAL_ADMIN_URL="postgres://…/postgres" \
REHEARSAL_SOURCE_URL="postgres://…/beauclick_v3_dev" \
REHEARSAL_APP_URL="postgres://beauclick_app:…@…/beauclick_v3_dev" \
pnpm restore:rehearse
```

`REHEARSAL_APP_URL` is optional and you should always set it. Without it the
run skips **the check the whole exercise exists for** and says so.

### What it checks, and why the last one matters most

1. The dump matches its manifest — sha256 and byte length — **before**
   restoring. A truncated dump restores a partial database perfectly happily,
   and `pg_restore` reports success for whatever it managed to read. A silent
   partial restore is strictly worse than a failed one.
2. Row counts match across every table.
3. The applied-migration list matches.
4. **The restored database still satisfies the role contract.**

That fourth check is why this is a script and not a shell one-liner. The
ledger's append-only guarantee is a role contract, not a column constraint. A
restore that returns every row and drops the grants produces a database where
`beauclick_financial_writer` can `UPDATE ledger_entries` — and every row is
present, every count matches, every query works, and every smoke test passes.
The failure is invisible to anything that only counts rows.

It is §9's own rule for object storage — *a restored file must not become more
publicly accessible than the original* — applied to the database, which is
where this platform's actual security boundary lives.

---

## Restoring for real

**Destructive downstream. Read this whole section first.**

The restore path creates a **new** database and refuses to restore over an
existing one. That refusal is the most important line in `backup-restore.ts`: a
restore is what you reach for when something has already gone wrong, under time
pressure, and `pg_restore --clean` into the wrong database destroys the data
somebody was about to recover.

1. **Do not drop anything yet.** Restore alongside.

   ```bash
   psql "$ADMIN_DATABASE_URL" -c 'CREATE DATABASE beauclick_recovered'
   ```

   (The tooling creates the target itself; this is here so the name is a
   deliberate choice rather than a default.)

2. Restore the dump into it, then verify exactly as the rehearsal does: row
   counts against the manifest, the migration list, and

   ```bash
   DATABASE_URL="postgres://beauclick_app:…@…/beauclick_recovered" pnpm verify:roles
   ```

   If the role contract fails on the restored copy, re-apply
   `financial-roles.sql` and `admin-audit-roles.sql` as a superuser and check
   again. **Do not point the application at it until this passes.** An
   application connected to a database whose ledger it can mutate has lost the
   guarantee silently, and nothing downstream will report it.

3. Only once verified, switch the application over. Keep the damaged database.
   It is evidence, it costs disk, and you will want it.

### Roles are cluster-global

`pg_dump` does not carry roles; `pg_dumpall --globals-only` does. Restoring
into a **new cluster** therefore needs the two role scripts applied first, or
every ownership assignment in the dump fails. Restoring into the same cluster
does not — the roles are already there. The rehearsal exercises the
same-cluster case; the new-cluster case is part of the drill that is still
open.

---

## Object storage

Not covered by any of this. `V3_INFRASTRUCTURE_PLAN.md` §9 requires
provider-native versioning and replication for verification evidence and
portfolio media, with the same protected-file security model extending to
restore. No provider is selected (`HOSTING`), and `media.objects` — the
authorization record for every file — **is** in the database backup, so a
database restore without the corresponding object restore yields a system that
knows about files it cannot serve.

Recorded here so it is not discovered during an incident.
