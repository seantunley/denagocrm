/**
 * Every Prisma model that carries a `deletedAt` (soft-delete / Trash) column MUST
 * be listed here — this is the registry the filtered `prisma` client uses to hide
 * and refuse trashed rows. A model with `deletedAt` that is missing from this set
 * would still resolve trashed rows through findUnique and be mutable through the
 * filtered client. The `softDeleteModels` unit test compares this set against the
 * Prisma schema and fails if the two ever drift, so a new soft-deletable model
 * can't be added without registering it here.
 */
export const SOFT_DELETE_MODELS = new Set([
  "Contact",
  "Lead",
  "Vehicle",
  "JobCard",
  "Document",
  "Product",
  "LibraryDocument",
  "Quote",
  "StockUnit",
  "PurchaseOrder",
  "Part",
  "Survey",
  "Fleet",
  "CustomDocTemplate",
  "DocInstance",
  "DocTemplateRecord",
  "ReusableBlock",
  "DocBuilderTemplate",
  "SignatureRequest",
  "SignWorkflow",
  "Competitor",
  "SalesPipeline",
  "Team",
]);
