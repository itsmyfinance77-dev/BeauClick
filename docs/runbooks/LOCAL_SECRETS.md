# Runbook — local development secrets

**Status:** ACTIVE. Recorded 2026-09-02.

## What changed, and why

Development credentials used to be literals in tracked files: a PostgreSQL
superuser password and MinIO root credentials in
`v3/infra/docker/docker-compose.yml`, a superuser connection string in a comment
in that same file alongside three financial-role passwords, an application
password as a fixture in `v3/libs/observability/src/redact.spec.ts`, and MinIO
credentials as fallback defaults in `v3/apps/api/test/media-s3.pg-spec.ts`.

They were convenient and they were wrong. A committed credential has three
properties that make it worse than an inconvenient one:

- it outlives the rotation meant to retire it, because rotation changes the
  server and the file still says otherwise;
- it stays readable in history even after the working tree is cleaned;
- it teaches the next reader that pasting one in is normal, which is how the
  fourth and fifth copies appear.

**Local secrets now come only from ignored environment configuration.**
`docker-compose.yml` declares each secret-bearing variable as `${VAR:?…}`, so
Compose refuses to start and names the missing variable rather than falling back
to a default. There is deliberately no fallback: a default password in a
committed file is a credential, and one that silently keeps working after a
rotation is the worst version of one.

## Where local secrets live

| Consumer | Source | Tracked? |
|---|---|---|
| Local Compose (`postgres`, `objectstorage`) | `v3/infra/docker/.env` | ignored — never commit |
| API and local tooling | `v3/apps/api/.env` | ignored — never commit |
| Template listing the required names | `v3/infra/docker/.env.example` | tracked, all secret values blank |
| CI | generated per run inside the workflow | tracked workflow, no real credential |

CI provisions its own ephemeral credentials for its own throwaway containers and
shares nothing with a developer machine. Do not point CI at a local value, and
do not copy a CI value locally.

## Historical values are invalid

**Every credential that was ever committed to this repository must be treated as
compromised and is now unusable.** The PostgreSQL roles were rotated on
2026-09-02; the MinIO root credential, `JWT_ACCESS_SECRET` and `OTP_HMAC_SECRET`
were rotated in the same remediation. Nothing that appears in the history of the
files named above will authenticate against anything.

**Git history was deliberately not rewritten.** Rewriting it would break every
existing clone, invalidate published commit hashes including the ones the
release audit and decision registers cite, and still not guarantee removal from
forks, caches or mirrors. Rotation makes the exposed values worthless, which is
the outcome a history rewrite is only an indirect way of approximating. The
honest record — that these values were once committed, and are now dead — is
more useful than a tidied history that hides it.

## Rules

1. Never commit a real credential, including in a comment, a test fixture, a
   fallback default, or an example that is also accepted as a working value.
2. Never document an example value that the system would accept. Examples are
   blank; generation instructions go beside them.
3. Generate every value independently. Never reuse one across two variables, two
   environments, or two machines.
4. Never pass a secret as a command-line argument — it is visible in process
   listings and shell history. Use an environment file or stdin.
5. **Production secrets must never reuse a local or CI value.** Local
   credentials protect containers on one developer's machine; they are not a
   security boundary and must never become one.
6. PostgreSQL roles are cluster-global, and `ALTER ROLE` does not invalidate
   existing sessions. After rotating, terminate sessions and reconnect, or a
   verification that "it still works" proves nothing.

## Generating a value

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Write it straight into the ignored `.env`; do not echo it first.
