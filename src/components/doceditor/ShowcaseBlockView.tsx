"use client";

import type { ShowcaseBlock } from "@/lib/doceditor/model";
import { showcaseBlockHtml } from "@/lib/doceditor/showcaseRender";

/**
 * Canvas preview of a showcase block: the SAME (escaped, colour-sanitised) HTML
 * the PDF prints, rendered unbound — merge fields and the sample vehicle show
 * where the quote's data will land. `logo` is whatever the canvas shows for the
 * brand banner, so both blocks follow the same logo.
 */
export function ShowcaseBlockView({ block, logo }: { block: ShowcaseBlock; logo?: string }) {
  return <div dangerouslySetInnerHTML={{ __html: showcaseBlockHtml(block, null, logo) }} />;
}
