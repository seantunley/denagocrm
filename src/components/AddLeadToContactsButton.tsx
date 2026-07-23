"use client";

import { LoaderCircle, UserRoundPlus } from "lucide-react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

export default function AddLeadToContactsButton({ compact = false }: { compact?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(compact ? "btn-primary btn-sm w-full" : "btn-secondary", "gap-2")}
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <UserRoundPlus className="size-4" />
      )}
      {pending ? "Adding to Contacts…" : "Add to Contacts"}
    </button>
  );
}
