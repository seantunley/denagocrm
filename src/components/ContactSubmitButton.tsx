"use client";

import { LoaderCircle, UserRoundPlus } from "lucide-react";
import { useSavePending } from "@/components/SaveForm";

export default function ContactSubmitButton({ label }: { label: string }) {
  // useSavePending, NOT useFormStatus: the enclosing <SaveForm> owns submission via
  // onSubmit, and useFormStatus only reports pending for React's native form-action
  // path. Left as it was, this button would simply never show pending again.
  const pending = useSavePending();
  const pendingLabel = label.toLowerCase().includes("save") ? "Saving changes…" : "Creating contact…";

  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary min-h-10 w-full gap-2 sm:w-auto sm:min-w-40"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <UserRoundPlus className="size-4" />}
      {pending ? pendingLabel : label}
    </button>
  );
}
