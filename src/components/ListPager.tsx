import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PAGE_SIZE, pageHref, type ListSearchParams } from "@/lib/listPaging";

/**
 * Previous / Next for a server-paged list. Plain links, so paging is a normal
 * navigation: back and refresh work, and every other search param is kept.
 */
export default function ListPager({
  path,
  params,
  page,
  total,
  pageSize = PAGE_SIZE,
  className,
}: {
  path: string;
  params: ListSearchParams;
  page: number;
  total: number;
  pageSize?: number;
  className?: string;
}) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const button = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <nav aria-label="Pages" className={cn("flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground", className)}>
      <span>
        Showing {first}–{last} of {total}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link href={pageHref(path, params, page - 1)} rel="prev" className={button}>
            Previous
          </Link>
        )}
        {page < pages && (
          <Link href={pageHref(path, params, page + 1)} rel="next" className={button}>
            Next
          </Link>
        )}
      </div>
    </nav>
  );
}
