import { cn } from "@/lib/utils";

/**
 * Standard page header — title + optional description on the left, actions on
 * the right. Every screen uses this so headers stay consistent and aligned.
 */
export function PageHeader({
  title,
  description,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.035em] text-foreground sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div data-slot="page-header-actions" className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}
