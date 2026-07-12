import Image from "next/image";

export default function SurveyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#090b0a] text-slate-100">
      <div className="pointer-events-none fixed -right-48 -top-56 size-[600px] rounded-full bg-orange-600/[0.08] blur-[120px]" />
      <header className="relative border-b border-white/[0.07] bg-black/10 backdrop-blur-xl">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <Image
            src="/branding/denago-cape-town-logo.png"
            alt="Denago Cape Town"
            width={230}
            height={58}
            className="h-7 w-auto object-contain"
          />
          <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Customer feedback</span>
        </div>
      </header>
      <main className="relative max-w-2xl mx-auto px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
