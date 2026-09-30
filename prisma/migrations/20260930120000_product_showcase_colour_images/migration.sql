-- Showcase quotation: one vehicle photo PER COLOUR, so a quote for a Lava
-- Rover XL shows the Lava cart and a White one the White cart. Stored as
-- { "<colour name>": "<stored-file ref>" } on the Product, edited on the product
-- page (Products → a model → "Quote showcase"). The existing showcaseImageRef
-- stays the fallback for a colour with no photo of its own.
--
-- Additive and nullable: every existing product keeps working exactly as before
-- (no colour photos → the default photo). Date-stamped so it sorts after
-- 20260929130000_doc_instance_doc_editor_model.
--
-- No RLS change: Product already carries its tenant policy (rows, not columns),
-- and crm_app's grants are table-level, so the new column is covered as it is.

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "showcaseColourImages" JSONB;
