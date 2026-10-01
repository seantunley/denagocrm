/**
 * The rich-text "＋ variable" picker. Every key here must be filled by a
 * renderer: company.* by companyTokens(), user.name / date.today by
 * documentGlobalTokens(), the rest by the quote and job-card contexts in
 * docbuilder/merge.ts (tests/docEditorMergeFields.test.ts holds that). A key a
 * given record cannot fill — lead.* on a job card — renders as the
 * unresolved-variable pill, like any other unfilled variable.
 */
export const VARIABLES: { group: string; fields: string[] }[] = [
  { group: "Company", fields: ["company.name", "company.address", "company.phone", "company.email", "company.website", "company.tagline"] },
  { group: "Customer", fields: ["customer.name", "customer.firstName", "customer.phone", "customer.email", "customer.address"] },
  { group: "Lead (quotes)", fields: ["lead.name", "lead.title", "lead.source", "lead.product", "lead.value"] },
  { group: "Quotation", fields: ["quote.number", "quote.date", "quote.validUntil", "quote.validDays", "quote.subtotal", "quote.vat", "quote.vatRate", "quote.total", "vehicle", "preparedBy"] },
  { group: "Job card", fields: ["jobcard.number", "jobcard.status", "jobcard.total", "vehicle.reg", "technician"] },
  { group: "Document", fields: ["user.name", "date.today"] },
];
