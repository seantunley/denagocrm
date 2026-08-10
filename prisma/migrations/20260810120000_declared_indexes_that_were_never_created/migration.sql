-- Two indexes the schema has always declared and the database never had.
--
-- `Team.@@index([managerId])` and `UserRole.@@index([roleId])` are both stated in
-- prisma/governance.prisma. Neither exists: Team has only the foreign-key
-- constraint — which is NOT an index in PostgreSQL, unlike MySQL, where an FK
-- creates one on the referencing column — and UserRole has only its tenantId
-- index and the (tenantId, userId, roleId) unique.
--
-- They were invisible rather than ignored. The migration runner's drift probe
-- diffed against prisma/schema.prisma alone while the schema is split across
-- thirteen files, so nothing in governance.prisma was ever compared against the
-- database at all. The probe now reads the whole directory, which is what
-- surfaced these; before that change its warning list could not have contained
-- them under any circumstances.
--
-- Both matter for reads that already happen: "which teams does this person
-- manage", and the role join that runs on every permission check.
--
-- Additive and reentrant: two plain indexes, no constraint, no column, no row.

CREATE INDEX IF NOT EXISTS "Team_managerId_idx" ON "Team"("managerId");

CREATE INDEX IF NOT EXISTS "UserRole_roleId_idx" ON "UserRole"("roleId");
