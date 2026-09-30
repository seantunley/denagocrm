import { redirect } from "next/navigation";

const REPOSITORY_FILTERS = ["q", "tag", "kind", "versions"] as const;

/**
 * Retired. Templates live in Document Studio and files in /documents; this
 * only forwards old links and bookmarks. The per-template editors under
 * /settings/documents/… are still served from here.
 */
export default async function DocumentsSettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const repository = params.tab === "repository" || REPOSITORY_FILTERS.some((key) => params[key] !== undefined);
  if (!repository) redirect("/document-studio");

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "tab" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const qs = query.toString();
  redirect(qs ? `/documents?${qs}` : "/documents");
}
