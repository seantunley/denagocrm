import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import ArticleBody from "@/components/help/ArticleBody";
import PrintButton from "@/components/help/PrintButton";
import { categoriesWithArticles, HELP_ARTICLES } from "@/lib/help/content";

export const metadata: Metadata = { title: "Denago CRM — User Manual", robots: { index: false, follow: false } };

const AUDIENCE_LABEL: Record<string, string> = { everyone: "", managers: "Managers", admins: "Admins only" };

export default async function ManualPage() {
  await requireUser();
  const categories = categoriesWithArticles();

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 print:py-0">
      <style>{`@media print { .break-before { break-before: page; } a { color: inherit; text-decoration: none; } }`}</style>

      {/* Cover */}
      <header className="mb-10 border-b-2 border-orange-500 pb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-600">Denago Cape Town</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900">User Manual</h1>
            <p className="mt-2 text-sm text-slate-500">
              The complete guide to Denago CRM — {HELP_ARTICLES.length} articles across {categories.length} areas.
            </p>
          </div>
          <PrintButton />
        </div>
      </header>

      {/* Contents */}
      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Contents</h2>
        <ol className="space-y-4">
          {categories.map((c, ci) => (
            <li key={c.key}>
              <p className="text-sm font-semibold text-slate-800">{ci + 1}. {c.label}</p>
              <ul className="mt-1 space-y-0.5 pl-5">
                {c.articles.map((a) => (
                  <li key={a.slug} className="text-[13px] text-slate-500">
                    <a href={`#${a.slug}`}>{a.title}</a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      {/* Body */}
      {categories.map((c, ci) => (
        <section key={c.key} className={ci > 0 ? "break-before pt-10" : "pt-2"}>
          <div className="mb-6 border-b border-slate-200 pb-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600">Section {ci + 1}</p>
            <h2 className="mt-1 text-2xl font-bold text-slate-900">{c.label}</h2>
            <p className="mt-1 text-sm text-slate-500">{c.description}</p>
          </div>

          <div className="space-y-10">
            {c.articles.map((a) => (
              <article key={a.slug} id={a.slug} className="scroll-mt-6">
                <div className="mb-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-xl font-semibold text-slate-900">{a.title}</h3>
                    {AUDIENCE_LABEL[a.audience] && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        {AUDIENCE_LABEL[a.audience]}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm italic text-slate-500">{a.summary}</p>
                </div>
                <ArticleBody body={a.body} variant="print" />
              </article>
            ))}
          </div>
        </section>
      ))}

      <footer className="mt-16 border-t border-slate-200 pt-4 text-center text-xs text-slate-400 print:hidden">
        Denago CRM User Manual · Generated from the in-app Help Centre
      </footer>
    </div>
  );
}
