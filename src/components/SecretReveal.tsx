"use client";

import { useState } from "react";
import { revealSecret } from "@/app/actions/settings";

/**
 * Shows a stored secret masked by default; the real value is fetched (owner-only
 * server action) only when the owner clicks Reveal/Copy — so it is never present
 * in the initial server-rendered page HTML.
 */
export default function SecretReveal({ settingKey, isSet }: { settingKey: string; isSet: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!isSet) {
    return <code className="flex-1 text-sm bg-muted rounded-lg px-3 py-2 text-muted-foreground">—</code>;
  }

  const fetchValue = async (): Promise<string> => {
    if (value !== null) return value;
    const v = await revealSecret(settingKey);
    setValue(v);
    return v;
  };

  const onReveal = async () => {
    setBusy(true);
    try {
      await fetchValue();
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(await fetchValue());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 gap-2">
      <code className="flex-1 text-sm bg-muted rounded-lg px-3 py-2 break-all">
        {value ?? "••••••••••••••••"}
      </code>
      {value === null && (
        <button type="button" className="btn-secondary" onClick={onReveal} disabled={busy}>
          Reveal
        </button>
      )}
      <button type="button" className="btn-secondary" onClick={onCopy} disabled={busy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
