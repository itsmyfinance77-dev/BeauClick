-- V3.3 Story #111 (`#44e`): scoped read-only business finance authority.
--
-- Bound by `V33-DEC-030` D4, ADR-049 section 5, `V33-DEC-020` Ruling 1 (still
-- unweakened) and `V33-DEC-033` R1/R2/R5. ADR-049 is the pre-code gate and is
-- already Accepted; no ADR-051 exists or is authorized, and no register card
-- was needed: D4 and ADR-049 section 5.1 already ratify "an explicit,
-- business-scoped, read-only grant ... through #109's grant store", and
-- `V33-DEC-033`'s own non-approvals hand finance to this story by name.
--
-- ## What this migration is: one CHECK, two members
--
-- `V33-DEC-033` R1 closed #109's vocabulary at exactly `practitioner_chat` and
-- said a second member needs an explicit decision tied to a real consumer. The
-- decision is D4; the consumer is `financial`'s workspace-aware read family.
-- The literal is `finance_read` -- not `finance` -- because the name carries
-- the only property the decision ratified (READ-ONLY; ADR-049 section 5.4's
-- access mode) and so that no future write authority could ever be confused
-- with it. `practitioner_chat` is preserved byte-for-byte, and the #109 suite's
-- proof that `'finance'` is refused by this CHECK stays true.
--
-- DROP + ADD in the runner's single transaction: PostgreSQL cannot alter a
-- CHECK expression in place. Re-adding validates the existing rows with a
-- scan (every one is `practitioner_chat`) but rewrites nothing, so every row
-- keeps its `xmin`; the #111 real-PostgreSQL suite proves that with a
-- non-vacuity control exactly as #109 did for `ck_business_staff_status`.
--
-- ## What this migration deliberately does NOT contain
--
-- No new table, no new column, no new index, no seed, no default row, no
-- backfill and no `UPDATE`. The scope columns, the composite same-business
-- foreign key `fk_staff_role_grants_membership_same_business`, the partial live
-- uniqueness `uq_staff_role_grants_live`, the revocation CHECK and the
-- immutability trigger `tg_staff_role_grants_immutable` are all untouched: a
-- `finance_read` grant is as unwritable across businesses, as immutable and as
-- one-way-revocable as a `practitioner_chat` grant, because it is the same row
-- shape under the same constraints.
--
-- No `business_staff` change of any kind. A bookkeeper is invited, consents
-- and is granted through the rows and routes #109 built; their membership's
-- `professional_id` is simply NULL, and the grant path (not the schema) is what
-- became role-aware so that NULL is legal for `finance_read` and still illegal
-- for `practitioner_chat`.
--
-- No `financial.*` change. The finance surface reads through the same
-- party-scoped statements as before; only WHICH parties a session may address
-- changed, and that lives in the composition root, not in a table.
--
-- No `CONCURRENTLY`. `database/scripts/migrate.ts` wraps each file in an
-- explicit BEGIN/COMMIT and PostgreSQL forbids CONCURRENTLY inside a
-- transaction.
ALTER TABLE business.staff_role_grants
    DROP CONSTRAINT ck_staff_role_grants_role;

ALTER TABLE business.staff_role_grants
    ADD CONSTRAINT ck_staff_role_grants_role
    CHECK (role IN ('practitioner_chat', 'finance_read'));

COMMENT ON TABLE business.staff_role_grants IS
    'V3.3 #109 (#44c) and #111 (#44e). Scoped staff authority, anchored on a consented business_staff membership. Two role vocabulary members: practitioner_chat (business-scoped row, practitioner-specific authority derived from the membership) and finance_read (business-scoped, read-only access to that business finance workspace; never a write, never ownership). Immutable facts plus one-way revocation; at most one live grant per (membership, role, business). ADR-027 subject_data.';
