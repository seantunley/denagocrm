import { redirect } from "next/navigation";
import { folderHref } from "@/lib/documentFolders";

/**
 * The Document Library is a section of Documents now. Old links and bookmarks
 * (/library, /library?cat=Brochure) land in the same place there. The layout's
 * library permission check still runs first.
 */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ cat?: string }> }) {
  const { cat } = await searchParams;
  redirect(folderHref({ kind: "library", category: cat?.trim() || null }));
}
