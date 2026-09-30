"use client";

import { useTransition } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { convertLeadToContact } from "@/app/actions/leads";

export default function AddToContactsButton({ leadId, label = "Add to contacts" }: { leadId: string; label?: string }) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await convertLeadToContact(leadId).catch(() => ({
        ok: false as const,
        error: "Something went wrong",
      }));
      if (result.ok) {
        toast.success("Contact created and linked");
      } else {
        toast.error(result.error ?? "Couldn't add to contacts");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="btn-secondary btn-sm inline-flex items-center gap-1"
    >
      <UserPlus className="size-3" />
      {isPending ? "Adding…" : label}
    </button>
  );
}
