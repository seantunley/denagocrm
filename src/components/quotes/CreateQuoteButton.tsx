"use client";

import { useTransition } from "react";
import { useRouter, unstable_rethrow } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createQuoteFromLead } from "@/app/actions/quotes";
import { Button } from "@/components/ui/button";

/** A quote on this deal, seeded from it (product, quantity, value), opened in the editor. */
export default function CreateQuoteButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const result = await createQuoteFromLead(leadId);
            if (result?.error) {
              toast.error(result.error);
              return;
            }
            toast.success(result?.success ?? "Quote created");
            if (result?.redirectTo) router.push(result.redirectTo);
          } catch (error) {
            unstable_rethrow(error);
            toast.error("Something went wrong. Please try again.");
          }
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <FileText />}Create quote
    </Button>
  );
}
