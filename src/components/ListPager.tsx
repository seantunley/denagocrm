"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PAGE_SIZE, pageHref } from "@/lib/listPaging";

/**
 * Previous / Next for a server-paged list. Plain links, so paging is a normal
 * navigation: back and refresh work, and every other search param is kept.
 *
 * A CLIENT component on purpose: the links are built from the LIVE URL, not the
 * params the server rendered with. The quote editor rewrites `?edit=` with
 * history.replaceState as quotes are opened and closed (#696), which Next syncs
 * into useSearchParams but never re-renders the server page for. Server-built
 * links would carry the `?edit=` the page first loaded with, and "Next" would
 * reopen a quote the user had already closed — the stale-edit bug #696 fixed.
 */
export default function ListPager({
  path,
  page,
  total,
  pageSize = PAGE_SIZE,
  className,
}: {
  path: string;
  page: number;
  total: number;
  pageSize?: number;
  className?: string;
}) {
  const params = useSearchParams();
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
