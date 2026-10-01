"use client";

import type { FormHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AvailabilityConflictDialog } from "@/components/AvailabilityConflictDialog";
import { ACTION_NOT_DELIVERED } from "@/components/actionError";

type Result = { error?: string; success?: string } | void;

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
      router.refresh();
    } catch {
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
