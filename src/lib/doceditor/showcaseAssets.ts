/**
 * Built-in background photos for the showcase quotation's header and footer
 * bands (Cape Town, Unsplash License — see public/branding/quote/CREDITS.txt).
 *
 * A template refers to them by merge token — `{{asset.showcaseHeader}}` — so
 * that the bytes are resolved where they can be:
 *   - server renders: showcaseAssetsServer.ts reads the files from disk and
 *     supplies the tokens as data URLs (never hot-linked from the PDF);
 *   - signing: service.ts resolves them into the snapshot at send time, like
 *     every other global, so a signed quote keeps the photo it was signed with;
 *   - the editor canvas (a browser): the public path below.
 * An uploaded band photo replaces the token with its own data URL.
 */
export const SHOWCASE_BAND_ASSETS = {
  "asset.showcaseHeader": "/branding/quote/header-table-mountain-panorama.jpg",
  "asset.showcaseFooter": "/branding/quote/footer-table-mountain-skyline.jpg",
} as const;

export const SHOWCASE_HEADER_IMAGE = "{{asset.showcaseHeader}}";
export const SHOWCASE_FOOTER_IMAGE = "{{asset.showcaseFooter}}";
