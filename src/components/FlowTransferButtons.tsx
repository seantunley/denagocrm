"use client";

import { useRef, useState, useTransition } from "react";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";
import { exportFlow, importFlow } from "@/app/actions/flowTransfer";

/** Download one flow's draft as a .flow.json file (lib/flowTransfer). */
export function ExportFlowButton({ flowId }: { flowId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      disabled={pending}
      title="Download this flow as a file — to keep, or to import into another workspace"
      onClick={() => start(async () => {
        const res = await exportFlow(flowId);
        if (res.error || !res.content || !res.fileName) { toast.error(res.error ?? "Could not export this flow."); return; }
        const url = URL.createObjectURL(new Blob([res.content], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = res.fileName;
        link.click();
        URL.revokeObjectURL(url);
      })}
    >
      <Download className="size-3.5" />{pending ? "Exporting…" : "Export"}
    </button>
  );
}

/** Pick a .flow.json file and import it as a new draft; opens it in the builder. */
export function ImportFlowButton() {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [name, setName] = useState<string | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="Flow file to import"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setName(file.name);
          const form = new FormData();
          form.set("file", file);
          start(async () => {
            const res = await importFlow(form);
            if (res?.error) toast.error(res.error);
            setName(null);
          });
        }}
      />
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => input.current?.click()} title="Import a flow exported from this or another workspace — it arrives as a draft">
        <Upload className="size-4" />{pending ? `Importing ${name ?? ""}…` : "Import"}
      </button>
    </>
  );
}
