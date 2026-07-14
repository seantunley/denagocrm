"use client";

import Link from "next/link";

export default function PrintActions({
  backHref,
  backLabel = "Back",
}: {
  backHref: string;
  backLabel?: string;
}) {
  return (
    <div className="print:hidden flex items-center gap-2 p-4 bg-slate-100 border-b border-slate-200">
      <button
        onClick={() => window.print()}
        className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 cursor-pointer"
      >
        🖨 Print
      </button>
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
      >
        ← {backLabel}
      </Link>
    </div>
  );
}
