import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export default function MarketingPageHeader({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4 border-b border-border/70 pb-5 lg:flex-row lg:items-end lg:justify-between", className)}>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-[-0.035em] text-foreground sm:text-2xl">{title}</h2>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{children}</div> : null}
    </header>
  );
}
