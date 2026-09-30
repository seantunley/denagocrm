"use client";

import type { InfoCardBlock, LineItemsBlock, ShowcaseBlock, TermsBlock } from "@/lib/doceditor/model";
import { showcaseBlockHtml, showcaseLookHtml } from "@/lib/doceditor/showcaseRender";
import { SHOWCASE_BAND_ASSETS } from "@/lib/doceditor/showcaseAssets";
import { useDocEditorEnv } from "./EditorContext";

/**
 * The canvas renders UNBOUND — merge fields and the sample vehicle show where
 * the quote's data will land — except that the built-in band photos resolve to
 * their public paths, so the designer sees the scenery the PDF embeds.
 */
const CANVAS_CTX = { tokens: { ...SHOWCASE_BAND_ASSETS }, items: [], vars: {}, bound: false };

/**
 * Canvas preview of a showcase block (or a shared block in the showcase look):
 * the SAME escaped, colour-sanitised HTML the PDF prints, with the workspace's
 * logo exactly as the brand banner on the canvas shows it.
 */
export function ShowcaseBlockView({ block }: { block: ShowcaseBlock | InfoCardBlock | LineItemsBlock | TermsBlock }) {
  const { logoSrc } = useDocEditorEnv();
  const html = block.type === "infoCard" || block.type === "lineItems" || block.type === "terms"
    ? showcaseLookHtml(block, CANVAS_CTX)
    : showcaseBlockHtml(block, CANVAS_CTX, logoSrc || undefined);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
