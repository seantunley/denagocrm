"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileCheck2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { finalizeDocInstance } from "@/app/actions/studio";
import { Button } from "@/components/ui/button";

/** Finalise a studio document: locks it and files the PDF in the repository. */
export default function StudioFinalize({ docId }: { docId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  if (done) return null;

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          toast("Generating PDF…");
          const res = await finalizeDocInstance(docId).catch(() => ({
            ok: false as const,
            error: "PDF generation failed",
          }));
          if (res.ok) {
            setDone(true);
            toast.success("Document finalised — PDF filed in the repository", {
              action: res.pdfDocId
                ? {
                    label: "Open PDF",
                    onClick: () => window.open(`/api/files/${res.pdfDocId}`, "_blank"),
                  }
                : undefined,
            });
            router.refresh();
          } else {
            toast.error(res.error ?? "Couldn't finalise");
          }
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <FileCheck2 className="size-4" />}
      {pending ? "Generating…" : "Finalise & PDF"}
    </Button>
  );
}
