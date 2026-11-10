"use client";

import { useState } from "react";

/**
 * What the deal file asks of one supplier: the workspace's default supplier list, or its own. The tick-boxes show
 * only for its own list; they start from its saved list, or from the default when it has none yet.
 */
export default function SupplierDocumentsFields({ types, defaults, own }: {
  /** The workspace's Document types — the only choices. */
  types: readonly string[];
  /** The default supplier list (Settings → Quotes → Deal file checklist). */
  defaults: readonly string[];
  /** Its own list, or null when it uses the default. */
  own: readonly string[] | null;
}) {
  const [mode, setMode] = useState<"default" | "own">(own === null ? "default" : "own");
  const start = own ?? defaults;
  return (
    <div className="grid gap-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="radio" name="mode" value="default" checked={mode === "default"} onChange={() => setMode("default")} className="h-4 w-4" />
        The default list{defaults.length ? ` (${defaults.join(", ")})` : " (nothing)"}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" name="mode" value="own" checked={mode === "own"} onChange={() => setMode("own")} className="h-4 w-4" />
        Its own list
      </label>
      {mode === "own" && (
        <div className="ml-6 grid gap-1.5">
          {types.map((type) => (
            <label key={type} className="flex items-center gap-2">
              <input type="checkbox" name="type" value={type} defaultChecked={start.includes(type)} className="h-4 w-4" />
              {type}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">Tick nothing to ask this supplier for nothing.</p>
        </div>
      )}
    </div>
  );
}
