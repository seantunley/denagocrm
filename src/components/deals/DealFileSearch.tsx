"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

/**
 * Filters the deal file as you type: hides every `[data-search]` row inside `#targetId` whose text doesn't
 * contain all the words (file name, type, supplier, who uploaded it). The rows are server-rendered, so this
 * only shows and hides them.
 */
export default function DealFileSearch({ targetId }: { targetId: string }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = document.getElementById(targetId)?.querySelectorAll<HTMLElement>("[data-search]") ?? [];
    rows.forEach((row) => {
      const text = row.dataset.search ?? "";
      row.hidden = !words.every((word) => text.includes(word));
    });
  }, [query, targetId]);
  return (
    <label className="relative block w-full sm:w-64">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search this deal's documents"
        aria-label="Search this deal's documents"
        className="input h-9 pl-8 text-sm"
      />
    </label>
  );
}
