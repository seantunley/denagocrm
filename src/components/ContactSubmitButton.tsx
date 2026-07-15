"use client";

import { LoaderCircle, UserRoundPlus } from "lucide-react";
import { useFormStatus } from "react-dom";

export default function ContactSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
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
