import Link from "next/link";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import PuckLoader from "./PuckLoader";

export const dynamic = "force-dynamic";

export default async function PuckPrototypePage() {
  await requireOwner();

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings/documents" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Documents
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <FlaskConical className="size-5 text-primary" />
          Document editor prototype — Puck
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
          The same Delivery Note as a drag-drop document — but every block is plain HTML/React, so
          the output flows into your existing Chromium→PDF pipeline. Throwaway; no live data touched.
        </p>
      </div>

      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 text-xs leading-5 text-muted-foreground">
        <p className="font-semibold text-foreground">What to try</p>
        <p className="mt-1">
          Drag blocks from the left, reorder them on the canvas, and click a block to edit its text on
          the right. The <strong className="text-foreground">Handover checklist</strong> is a locked,
          data-driven block with no editable fields — staff can move it but can&apos;t break it.
        </p>
        <p className="mt-2 text-emerald-300/90">
          Upside vs pdfme: output is HTML into your current single PDF engine — no second renderer, and
          your existing print layouts can be reused as blocks. Trade-off: it&apos;s more of a hand-build
          than pdfme&apos;s ready-made designer.
        </p>
      </div>

      <PuckLoader />
    </div>
  );
}
