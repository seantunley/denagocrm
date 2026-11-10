-- A supplier's own deal-file documents (Sean, 2026-11-10: "different documents per supplier").
-- NULL = the workspace's default supplier list (Settings → Quotes → Deal file checklist); a JSON array = its own.
-- Additive; re-runnable. The table already has RLS and its grants.
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "requiredDocuments" JSONB;
