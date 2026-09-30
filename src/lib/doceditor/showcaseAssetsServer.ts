import "server-only";
import fs from "fs";
import path from "path";

let cache: Record<string, string> | undefined;

/**
 * The showcase band photos as data URLs, keyed by merge token (see
 * showcaseAssets.ts). Read from disk once, like the built-in logo in
 * signing/render.ts — the path segments are literal so file tracing ships the
 * files with every server function that renders a document. A missing file
 * yields no token, and the band falls back to its plain dark gradient.
 */
export function showcaseAssetTokens(): Record<string, string> {
  if (cache) return cache;
  const read = (file: string) => {
    try {
      return `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      return null;
    }
  };
  const header = read(path.join(process.cwd(), "public", "branding", "quote", "header-table-mountain-panorama.jpg"));
  const footer = read(path.join(process.cwd(), "public", "branding", "quote", "footer-table-mountain-skyline.jpg"));
  cache = {
    ...(header ? { "asset.showcaseHeader": header } : {}),
    ...(footer ? { "asset.showcaseFooter": footer } : {}),
  };
  return cache;
}
