import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getArticle } from "@/lib/help/content";
import { isArticleEnabled } from "@/lib/help/modules";
import { getEnabledModuleIds } from "@/lib/modules/enabled";

/**
 * One Help Centre article, for the "?" side panel (components/help/ScreenHelp.tsx). Signed-in staff only, the same as
 * /help itself. Fetched when the panel opens, so the whole Help Centre never ships to the browser.
 *
 * An article for a switched-off module answers 404, as /help/[slug] does. Module state that can't be read leaves the
 * article shown: help text isn't sensitive, and a panel that went blank on a transient error would be worse.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const enabled = await getEnabledModuleIds().catch(() => null);
  if (enabled && !isArticleEnabled(article, enabled)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    { slug: article.slug, title: article.title, summary: article.summary, body: article.body },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
