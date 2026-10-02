"use client";

import type { FormHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { toast } from "sonner";
import { AvailabilityConflictDialog } from "@/components/AvailabilityConflictDialog";
import { ACTION_NOT_DELIVERED } from "@/components/actionError";

type Result = { error?: string; success?: string; redirectTo?: string } | void;

export function ConflictAwareForm({
  action,
  children,
  conflictTitle = "Calendar conflict",
  successMessage,
  ...props
}: Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "onSubmit" | "children"> & {
  action: (formData: FormData) => Promise<Result>;
  children: ReactNode;
  conflictTitle?: string;
  successMessage?: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function submit(formData: FormData) {
    try {
      const result = await action(formData);
      if (result?.error) {
        setMessage(result.error);
        return;
      }
      if (result?.success || successMessage) {
        toast.success(result?.success ?? successMessage);
      }
      // Navigate only where the ACTION says the save landed, as SaveForm does.
      if (result?.redirectTo) {
        router.push(result.redirectTo);
        return;
      }
      router.refresh();
    } catch (error) {
      // Framework signals (an action's redirect, notFound) pass through untouched,
      // as in SaveForm. Swallowing them reported a booking that HAD been made as
      // "no reply from the server" and invited a duplicate re-submit.
      unstable_rethrow(error);
      toast.error(ACTION_NOT_DELIVERED);
    }
  }

  return (
    <>
      <form action={submit} {...props}>
        {children}
      </form>
      <AvailabilityConflictDialog
        message={message}
        onClose={() => setMessage(null)}
        title={conflictTitle}
      />
    </>
  );
}
