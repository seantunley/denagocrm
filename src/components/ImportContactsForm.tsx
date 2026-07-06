"use client";

import { useActionState } from "react";
import { importContacts, type ImportState } from "@/app/actions/import";

export default function ImportContactsForm() {
  const [state, formAction, pending] = useActionState<ImportState | undefined, FormData>(
    importContacts,
    undefined
  );
  return (
    <form action={formAction} className="space-y-3">
      <input
        type="file"
        name="file"
        accept=".csv,text/csv"
        required
        className="text-sm w-full file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300"
      />
      {state?.ok && <p className="text-sm text-emerald-400">{state.ok}</p>}
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "Importing…" : "Import contacts"}
      </button>
    </form>
  );
}
