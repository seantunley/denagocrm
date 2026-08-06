import { customerBrand, BrandStyle } from "@/lib/loginBrand";
import BrandLogo from "@/components/BrandLogo";

/**
 * Public survey response pages.
 *
 * HOSTNAME ONLY, and that is a limitation worth naming rather than hiding: the
 * tenant IS knowable from the survey token, but the token lives in the PAGE's
 * params and a layout does not receive them. Passing null here makes
 * customerBrand fall straight through to the hostname.
 *
 * For white-label that is the right answer anyway — a survey link goes out on the
 * tenant's own domain, so the hostname already identifies them. It is only wrong
 * for a survey opened on the platform's default domain, which under per-tenant
 * domains should not happen. If it ever has to be exact, the page can resolve
 * from its token and hand the brand down, and this layout would stop rendering
 * the header itself.
 */
export default async function SurveyLayout({ children }: { children: React.ReactNode }) {
  const brand = await customerBrand(null);
  return (
    <>
      <BrandStyle brand={brand} />
      <div className="relative min-h-screen overflow-hidden bg-[#090b0a] text-slate-100">
        <div className="pointer-events-none fixed -right-48 -top-56 size-[600px] rounded-full bg-orange-600/[0.08] blur-[120px]" />
        <header className="relative border-b border-white/[0.07] bg-black/10 backdrop-blur-xl">
          <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
            <BrandLogo
              logoUrl={brand.logoUrl}
              alt={brand.displayName}
              className="h-7 w-auto object-contain"
            />
            <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Customer feedback</span>
          </div>
        </header>
        <main className="relative max-w-2xl mx-auto px-4 py-8 sm:py-12">{children}</main>
      </div>
    </>
  );
}
