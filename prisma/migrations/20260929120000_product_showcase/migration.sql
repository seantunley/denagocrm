-- Showcase quotation: the vehicle hero shows the quote's model with its photo,
-- tagline and up to four spec icons. These live on the Product, edited on the
-- product page (Products → a model → "Quote showcase").
--
-- Additive and nullable: every existing product keeps working and simply has no
-- showcase photo/specs until someone adds them, in which case the layout hides
-- those parts. Date-stamped (not numbered) so it sorts after the tenancy
-- migrations — see 20260831100000_comment_threads for why that matters.
--
-- No RLS change: Product already carries its tenant policy (rows, not columns),
-- and crm_app's grants are table-level, so new columns are covered as they are.

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "showcaseTagline" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "showcaseSpecs" JSONB;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "showcaseImageRef" TEXT;
