/**
 * CSS values that are safe to splice into a `style="..."` attribute.
 *
 * The document serializer builds inline styles by string concatenation:
 *
 *     `<th style="background:${block.headerBg};color:${block.headerColor}">`
 *
 * Text content goes through `esc()`, but these never did — and every one of them
 * is a plain `z.string()` a template author types. A value of
 *
 *     #fff" onmouseover="alert(1)" x="
 *
 * therefore closes the style attribute and adds an event handler to the tag.
 * Verified against a real production template ("Sales agreement"): `accent`,
 * `color`, `bg`, `headerBg`, `headerColor` and `ink` all broke out. `fontFamily`
 * and `align` did not, because they are `z.enum` — which is the whole argument
 * for constraining the rest.
 *
 * That is stored XSS on the PUBLIC signing page. The rendered sheets are handed
 * to `dangerouslySetInnerHTML` in SignSurface, so the payload runs in the
 * customer's browser, on our origin, on the page where they are about to sign a
 * binding document and where their signing token is in the URL. The author needs
 * only `docbuilder.manage`; the victim needs no account at all.
 *
 * ALLOWLIST, NOT ESCAPING. Escaping the quotes would stop the attribute
 * breakout and still allow CSS injection inside the attribute — `url(...)`,
 * `position:fixed` overlays, content that misrepresents what is being signed.
 * A colour field should hold a colour, so this accepts only colour syntax and
 * substitutes the caller's default for anything else.
 */

/**
 * `#rgb` / `#rrggbb` / `#rrggbbaa`, the functional forms, and bare keywords
 * (`red`, `transparent`, `currentColor`). A keyword that is not real is inert —
 * browsers drop a declaration they cannot parse — so there is no need to carry a
 * list of the 148 named colours.
 */
const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9a-z\s.,%/-]{1,60}\)|[a-z]{3,20})$/i;

/**
 * A colour, or `fallback` when the value is not one.
 *
 * Falls back silently rather than throwing: this runs while rendering a document
 * a customer is waiting on, and a template with one odd colour should render in
 * the default rather than fail to render at all. The value is refused, not
 * repaired — nothing here tries to salvage the interesting part of a payload.
 */
export function cssColor(value: string | null | undefined, fallback: string): string {
  const candidate = (value ?? "").trim();
  return SAFE_COLOR.test(candidate) ? candidate : fallback;
}

/** True when the value would be accepted as-is. For validation and tests. */
export function isSafeCssColor(value: string): boolean {
  return SAFE_COLOR.test(value.trim());
}
