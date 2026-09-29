import { redirect } from "next/navigation";

/** Retired: the builder list now lives in Document Studio. Keeps a record search (`q`). */
export default async function BuilderRedirect({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  redirect(q ? `/document-studio?q=${encodeURIComponent(q)}#builder` : "/document-studio");
}
