"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { createApiKey, revokeApiKey } from "@/app/actions/apiKeys";

export type ApiKeyRow = { id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string | null };

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }) : "never";

/**
 * This workspace's API keys: make one (shown once, then only its first
 * characters), see when each was last used, revoke one.
 */
export default function ApiKeysPanel({ keys, endpoint }: { keys: ApiKeyRow[]; endpoint: string }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<{ rawKey: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      setError(null);
      setCopied(false);
      const result = await createApiKey(label);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setMade({ rawKey: result.rawKey, label: label.trim() });
      setLabel("");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        POST leads from your website or landing pages to <code>{endpoint}</code> with the key in an <code>X-Api-Key</code> header.
        Fields: name (required), email, phone, message, model, color, source. The same key works for bookings and the service
        lookup. Each key belongs to this workspace only.
      </p>

      {made && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm" role="status">
          <p className="font-medium text-foreground">Your new key{made.label ? ` for “${made.label}”` : ""} — copy it now</p>
          <p className="mt-1 text-xs text-muted-foreground">It is shown this once. Only its first characters are kept to tell keys apart.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="block flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">{made.rawKey}</code>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => navigator.clipboard?.writeText(made.rawKey).then(() => setCopied(true)).catch(() => setCopied(false))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="label" htmlFor="api-key-label">New key — where it will be used</label>
          <input id="api-key-label" className="input" maxLength={60} placeholder="e.g. Website" value={label} onChange={(event) => setLabel(event.target.value)} />
        </div>
        <button type="button" className="btn-primary" disabled={pending} onClick={create}>
          {pending ? "Making…" : "Make key"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}

      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground">No keys yet — your website can&apos;t send leads until you make one.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{key.label}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{key.prefix}…</span> · made {day(key.createdAt)} · last used {day(key.lastUsedAt)}
                </p>
              </div>
              <SaveForm success="Key revoked" action={revokeApiKey.bind(null, key.id)}>
                <SaveButton className="btn-secondary btn-sm text-red-400">Revoke</SaveButton>
              </SaveForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
