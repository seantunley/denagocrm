"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Braces, BookMarked, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { MergeFieldDef } from "@/lib/mergeFields";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

// BlockNote touches window — client-only
const BlockNoteInner = dynamic(() => import("./StudioEditorInner"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Loading editor…
    </div>
  ),
});

export type Clause = { id: string; name: string; category: string | null; contentJson: unknown };

/**
 * Shared Studio editor shell: title, save-status, merge-field + clause pickers,
 * BlockNote canvas. Used by both template and document editors.
 */
export default function StudioEditor({
  initialTitle,
  initialContent,
  fields,
  clauses,
  readOnly = false,
  onSave,
  headerRight,
}: {
  initialTitle: string;
  initialContent: unknown;
  fields: MergeFieldDef[];
  clauses: Clause[];
  readOnly?: boolean;
  onSave: (data: { title: string; content: unknown }) => Promise<{ ok: boolean; error?: string }>;
  headerRight?: React.ReactNode;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<"saved" | "saving" | "dirty">("saved");
  const contentRef = useRef<unknown>(initialContent);
  const insertRef = useRef<{ insertToken: (t: string) => void; insertBlocks: (b: unknown) => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = useMemo(() => {
    const g = new Map<string, MergeFieldDef[]>();
    for (const f of fields) g.set(f.group, [...(g.get(f.group) ?? []), f]);
    return [...g.entries()];
  }, [fields]);

  function scheduleSave() {
    if (readOnly) return;
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus("saving");
      const res = await onSave({ title, content: contentRef.current }).catch(() => ({
        ok: false as const,
        error: "Save failed",
      }));
      if (res.ok) setStatus("saved");
      else {
        setStatus("dirty");
        toast.error(res.error ?? "Couldn't save");
      }
    }, 1200);
  }

  // Title edits save too
  useEffect(() => {
    if (title !== initialTitle) scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          readOnly={readOnly}
          className="min-w-48 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-semibold text-foreground outline-none transition-colors hover:border-input focus:border-ring"
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {status === "saving" ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Saving…
            </>
          ) : status === "saved" ? (
            <>
              <Check className="size-3 text-emerald-400" /> Saved
            </>
          ) : (
            "Unsaved changes"
          )}
        </span>

        {!readOnly && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Braces className="size-3.5" />
                  Merge field
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 w-64 overflow-y-auto">
                {groups.map(([group, defs], i) => (
                  <div key={group}>
                    {i > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {group}
                    </DropdownMenuLabel>
                    {defs.map((f) => (
                      <DropdownMenuItem
                        key={f.key}
                        onSelect={() => insertRef.current?.insertToken(`{{${f.key}}}`)}
                      >
                        <span className="flex-1">{f.label}</span>
                        <code className="text-[10px] text-muted-foreground">{f.key}</code>
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {clauses.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <BookMarked className="size-3.5" />
                    Insert clause
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-80 w-64 overflow-y-auto">
                  {clauses.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onSelect={() => insertRef.current?.insertBlocks(c.contentJson)}
                    >
                      <span className="flex-1">{c.name}</span>
                      {c.category && (
                        <span className="text-[10px] text-muted-foreground">{c.category}</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
        {headerRight}
      </div>

      <div className="min-h-[60vh] rounded-xl border border-border bg-card py-4 shadow-sm">
        <BlockNoteInner
          initialContent={initialContent}
          readOnly={readOnly}
          onChange={(c) => {
            contentRef.current = c;
            scheduleSave();
          }}
          registerApi={(api) => (insertRef.current = api)}
        />
      </div>
    </div>
  );
}
