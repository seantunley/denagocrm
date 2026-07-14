"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useFormStatus } from "react-dom";

export default function LeadSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  const pendingLabel = label.toLowerCase().includes("save") ? "Saving changes…" : "Creating lead…";

  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary min-h-10 w-full gap-2 sm:w-auto sm:min-w-40"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      {pending ? pendingLabel : label}
    </button>
  );
}
