"use client";

import type { InfoCardBlock, LineItemsBlock, ShowcaseBlock, TermsBlock } from "@/lib/doceditor/model";
import { showcaseBlockHtml, showcaseLookHtml } from "@/lib/doceditor/showcaseRender";
import { SHOWCASE_BAND_ASSETS } from "@/lib/doceditor/showcaseAssets";

/**
 * The canvas renders UNBOUND — merge fields and the sample vehicle show where
 * the quote's data will land — except that the built-in band photos resolve to
 * their public paths, so the designer sees the scenery the PDF embeds.
 */
const CANVAS_CTX = { tokens: { ...SHOWCASE_BAND_ASSETS }, items: [], vars: {}, bound: false };

/**
 * Canvas preview of a showcase block (or a shared block in the showcase look):
 * the SAME escaped, colour-sanitised HTML the PDF prints. `logo` is whatever the
 * canvas shows for the brand banner, so both blocks follow the same logo.
 */
export function ShowcaseBlockView({ block, logo }: { block: ShowcaseBlock | InfoCardBlock | LineItemsBlock | TermsBlock; logo?: string }) {
  const html = block.type === "infoCard" || block.type === "lineItems" || block.type === "terms"
    ? showcaseLookHtml(block, CANVAS_CTX)
    : showcaseBlockHtml(block, CANVAS_CTX, logo);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
