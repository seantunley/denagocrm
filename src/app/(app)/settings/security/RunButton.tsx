"use client";

import { useFormStatus } from "react-dom";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Submit button for the security runbook form, with a live pending state so a
 *  slow probe sweep no longer looks like a dead button. */
export function RunButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
      {pending ? "Running checks…" : "Run checks now"}
    </Button>
  );
}
