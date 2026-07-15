import { Check, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BuilderWorkspaceShell({
  children,
  fullscreen = false,
  className,
}: {
  children: ReactNode;
  fullscreen?: boolean;
  className?: string;
}) {
  return (
    <section
      data-slot="builder-workspace"
      className={cn(
        "flex min-h-[42rem] flex-col overflow-hidden rounded-2xl border border-border bg-[#0d1110] text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,.28)]",
        fullscreen && "fixed inset-0 z-[70] h-dvh min-h-0 rounded-none",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function BuilderWorkspaceBar({
  title,
  description,
  identity,
  status,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  identity?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex min-h-16 flex-wrap items-center gap-2 border-b border-white/[0.08] bg-[#111614] px-3 py-2.5 sm:px-4", className)}>
      {identity && <div className="shrink-0">{identity}</div>}
      {(title || description) && (
        <div className="min-w-40 flex-1">
          {title && <div className="truncate text-sm font-semibold text-white sm:text-base">{title}</div>}
          {description && <div className="mt-0.5 hidden truncate text-xs text-slate-400 sm:block">{description}</div>}
        </div>
      )}
      {status && <div className="ml-auto shrink-0">{status}</div>}
      {children && <div className={cn("flex flex-wrap items-center gap-2", !title && !description && !status && "w-full")}>{children}</div>}
    </header>
  );
}

export function BuilderSaveStatus({
  status,
  readOnly = false,
}: {
  status: string;
  readOnly?: boolean;
}) {
  if (readOnly) return <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Read only</span>;
  const normal = status.toLowerCase();
  const saving = normal.includes("saving");
  const saved = normal === "saved" || normal.includes("all changes saved");
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-400" role="status" aria-live="polite">
      {saving ? <Loader2 className="size-3.5 animate-spin text-primary" /> : saved ? <Check className="size-3.5 text-emerald-400" /> : <span className="size-2 rounded-full bg-amber-400" />}
      {saving ? "Saving…" : saved ? "Saved" : status}
    </span>
  );
}

export function BuilderWorkspaceCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 bg-[#0b0f0e]", className)}>{children}</div>;
}
