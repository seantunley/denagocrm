"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { assignLead } from "@/app/actions/leads";

export default function AttentionQuickAssign({
  leadId,
  ownerId,
  users,
}: {
  leadId: string;
  ownerId: string | null;
  users: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(ownerId ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <select
      className="input h-8 w-40 text-xs"
      aria-label="Assign lead"
      value={value}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        if (!next) return;
        const previous = value;
        setValue(next);
        startTransition(async () => {
          const result = await assignLead(leadId, next).catch(() => ({ ok: false as const, error: "Assignment failed" }));
          if (!result.ok) {
            setValue(previous);
            toast.error(result.error);
            return;
          }
          toast.success(`Assigned to ${result.assignee?.name ?? "team member"}`);
          router.refresh();
        });
      }}
    >
      <option value="" disabled>Assign…</option>
      {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select>
  );
}
