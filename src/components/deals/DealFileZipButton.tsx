"use client";

import { useState } from "react";
import { Download, Lock } from "lucide-react";
import { ZIP_PASSWORD_MIN, zipPasswordProblem } from "@/lib/dealFileZipRules";

/**
 * "Download ZIP" on the deal file: a password typed twice, then the whole file as one AES-256 ZIP with a cover sheet
 * (api/deals/[id]/file-zip). The password goes in the request body only — the CRM never keeps it, so it is told to
 * the recipient separately. Fields are cleared once the download starts.
 */
export default function DealFileZipButton({ quoteId }: { quoteId: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error?: string; done?: string } | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => { setOpen(true); setMessage(null); }} className="btn-secondary btn-sm">
        <Download className="size-4" />Download ZIP
      </button>
    );
  }
  const problem = password || confirm ? zipPasswordProblem(password, confirm) : null;
  return (
    <form
      className="grid w-full gap-2 rounded-xl border border-border bg-muted/20 p-3 text-xs sm:w-80"
      onSubmit={async (event) => {
        event.preventDefault();
        if (zipPasswordProblem(password, confirm)) return;
        setBusy(true);
        setMessage(null);
        try {
          const body = new FormData();
          body.set("password", password);
          body.set("confirm", confirm);
          const res = await fetch(`/api/deals/${quoteId}/file-zip`, { method: "POST", body });
          if (!res.ok || !(res.headers.get("content-type") ?? "").includes("zip")) {
            setMessage({ error: res.ok ? "You can't download this deal file." : (await res.text()) || "The download failed." });
            return;
          }
          const name = decodeURIComponent((res.headers.get("content-disposition") ?? "").split("''")[1] ?? "Deal file.zip");
          const url = URL.createObjectURL(await res.blob());
          const link = document.createElement("a");
          link.href = url;
          link.download = name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          setPassword("");
          setConfirm("");
          setMessage({ done: "Downloaded. Send the password to the recipient separately — e.g. by SMS, not in the same email." });
        } catch {
          setMessage({ error: "The download failed — try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground"><Lock className="size-3.5" />Password-protect the ZIP</p>
      <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Password (at least ${ZIP_PASSWORD_MIN} characters)`} aria-label="ZIP password" className="input h-8 text-xs" />
      <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" aria-label="Confirm ZIP password" className="input h-8 text-xs" />
      {problem && confirm && <p className="text-amber-400">{problem}</p>}
      <p className="text-muted-foreground">
        Includes a cover sheet with the checklist and an index, the quotations, and every filed document. The password isn&apos;t stored anywhere —
        keep it. Opens in 7-Zip or WinRAR (Windows) or The Unarchiver (Mac); Windows&apos; own &quot;Extract all&quot; can&apos;t open it.
      </p>
      {message?.error && <p className="text-red-400">{message.error}</p>}
      {message?.done && <p className="text-emerald-400">{message.done}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || zipPasswordProblem(password, confirm) !== null} className="btn-primary btn-sm">
          <Download className="size-3.5" />{busy ? "Preparing…" : "Download"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setPassword(""); setConfirm(""); }} className="btn-secondary btn-sm">Close</button>
      </div>
    </form>
  );
}
