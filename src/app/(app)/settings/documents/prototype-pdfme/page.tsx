import Link from "next/link";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { PdfmeDocEditor } from "./PdfmeDocEditor";

export const dynamic = "force-dynamic";

export default async function PdfmePrototypePage() {
  await requireOwner();

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings/documents" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Documents
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <FlaskConical className="size-5 text-primary" />
          Document editor prototype — pdfme
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
          A spike to feel a real drag-drop WYSIWYG editor on your actual documents — switch between
          the Delivery Note and Quotation (both converted from the live layouts). Throwaway; it does
          not touch your live templates or any customer data.
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4 text-xs leading-5 text-muted-foreground">
        <p className="font-semibold text-foreground">What to try</p>
        <p className="mt-1">
          Click any field to select it; drag to move, drag a corner to resize, edit text inline, and add fields from
          the left toolbar. Hit <strong className="text-foreground">Generate PDF</strong> to render the actual document
          with mock data. Fields are bound by name, so in a real integration the CRM record would fill them.
        </p>
        <p className="mt-2 text-amber-300/90">
          Trade-off to remember: pdfme renders with its own engine (not your HTML→Chromium pipeline). Adopting it for
          real means rebuilding each document this way and running two PDF engines — the win is this editing experience.
        </p>
      </div>

      <PdfmeDocEditor />
    </div>
  );
}
