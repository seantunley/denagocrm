"use client";

import { useActionState } from "react";
import { LoaderCircle, Play, ShieldCheck } from "lucide-react";
import {
  runBackupNow,
  verifyBackup,
  type BackupActionState,
} from "@/app/actions/backups";
import { Button } from "@/components/ui/button";

const initialState: BackupActionState = {};

export function RunBackupControl() {
  const [state, action, pending] = useActionState(runBackupNow, initialState);
  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <form action={action}>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
          {pending ? "Backing up…" : "Run backup now"}
        </Button>
      </form>
      {(state.ok || state.error) && (
        <p className={`max-w-sm text-xs ${state.error ? "text-red-400" : "text-emerald-400"}`} role="status">
          {state.error ?? state.ok}
        </p>
      )}
    </div>
  );
}

export function VerifyBackupControl({ pathname }: { pathname: string }) {
  const [state, action, pending] = useActionState(verifyBackup, initialState);
  return (
    <form action={action} className="flex flex-col items-end gap-1.5">
      <input type="hidden" name="pathname" value={pathname} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
        {pending ? "Checking…" : "Verify"}
      </Button>
      {state.pathname === pathname && (state.ok || state.error) && (
        <span className={`max-w-64 text-right text-[11px] ${state.error ? "text-red-400" : "text-emerald-400"}`} role="status">
          {state.error ?? state.ok}
        </span>
      )}
    </form>
  );
}
