-- Custom fields everywhere (2026-11-10): "show only when…" and record-link fields.
-- showWhen: NULL = always shown; else {"key": "<other field key>", "op": "equals"|"not_equals"|"filled", "value"?: "..."}.
-- linkTo:   for a "link to a record" field, what it links to (contact | lead | vehicle | product); NULL otherwise.
-- Additive; re-runnable. The table already has RLS and its grants.
ALTER TABLE "CustomFieldDef" ADD COLUMN IF NOT EXISTS "showWhen" JSONB;
ALTER TABLE "CustomFieldDef" ADD COLUMN IF NOT EXISTS "linkTo" TEXT;
