import { requireUser } from "@/lib/auth";
import HelpNav from "@/components/help/HelpNav";
import HelpFrame from "@/components/help/HelpFrame";
import { categoriesWithArticles } from "@/lib/help/content";
import { loadCustomGuides } from "@/lib/help/customGuidesStore";
import { getEnabledModuleIds } from "@/lib/modules/enabled";

export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  const [enabled, ownGuides] = await Promise.all([getEnabledModuleIds(), loadCustomGuides().catch(() => [])]);
  const builtIn = categoriesWithArticles(enabled).map((c) => ({
    key: c.key,
    label: c.label,
    articles: c.articles.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, keywords: a.keywords })),
  }));
  // The workspace's own guides lead the side menu and its search. Their "slug" is their path under /help, so the
  // menu links and highlights them like any other guide.
  const groups = ownGuides.length
    ? [{ key: "ours", label: "Our own guides", articles: ownGuides.map((g) => ({ slug: `ours/${g.id}`, title: g.title, summary: g.summary, keywords: [] as string[] })) }, ...builtIn]
    : builtIn;

  // A guide is read beside the side menu; the home has the page to itself (components/help/HelpFrame.tsx).
  return (
    <HelpFrame nav={<HelpNav groups={groups} />}>{children}</HelpFrame>
  );
}
