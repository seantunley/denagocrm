/*
 * A WORKSPACE'S APP ICON (Sean, 2026-11-24: the tab icon "is not updated per tenant"; "the denago icons stay D?").
 * The browser tab, the installed app and the assistant's notifications all show the SIGNED-IN workspace's icon:
 *
 *   1. its own square app icon (Settings → Company profile / the console), else
 *   2. its logo, centred on a square, else
 *   3. the platform's neutral icon — never another workspace's mark (the platform's used to be Denago's "D").
 *
 * Pure and client-safe: URLs only. The pictures are drawn by /api/brand/icon/[tenantId].
 */

export const APP_ICON_SIZES = [180, 192, 512] as const;
export type AppIconSize = (typeof APP_ICON_SIZES)[number];

/** The platform's own files, for a request that names no workspace. */
const PLATFORM_FILES: Record<AppIconSize, string> = {
  180: "/icons/apple-touch-icon.png",
  192: "/icons/icon-192.png",
  512: "/icons/icon-512.png",
};
const PLATFORM_MASKABLE = "/icons/icon-maskable-512.png";

/** A stored icon's file name (icon-<stamp>.<ext>), or null — so a path can never be named. */
export function brandIconAsset(ref: string | null | undefined): string | null {
  const name = (ref ?? "").split("/").pop() ?? "";
  return /^icon-\d{10,16}\.(png|jpe?g|webp)$/i.test(name) ? name : null;
}

export function appIconSize(value: unknown): AppIconSize {
  const n = Number(value);
  return (APP_ICON_SIZES as readonly number[]).includes(n) ? (n as AppIconSize) : 192;
}

type IconBrand = { tenantId: string | null; iconRef?: string | null; logoRef: string | null };

/**
 * The icon URL for a workspace. `v` changes whenever its icon or logo is replaced, so the URL can be cached hard and a
 * new upload is still picked up.
 */
export function appIconUrl(brand: IconBrand, size: AppIconSize, maskable = false): string {
  if (!brand.tenantId) return maskable ? PLATFORM_MASKABLE : PLATFORM_FILES[size];
  const version = brandIconAsset(brand.iconRef) ?? (brand.logoRef ?? "").split("/").pop() ?? "";
  return `/api/brand/icon/${brand.tenantId}?s=${size}${maskable ? "&m=1" : ""}&v=${encodeURIComponent(version || "platform")}`;
}

/**
 * An uploaded icon in its maskable form: launchers crop to a circle that keeps the middle 80%, so the art is drawn
 * inside it — 10% each side — on its own backdrop colour (review of #1221).
 */
export const MASKABLE_ICON_PADDING = 0.1;

/** Room left around a logo drawn on the square: maskable icons are cropped to a circle, so they need more. */
export function logoPadding(maskable: boolean): number {
  return maskable ? 0.24 : 0.12;
}

/**
 * The backing for a logo with see-through parts: dark behind a light logo, white behind a dark one. `luminance` is the
 * logo's average brightness (0–1) over its visible pixels.
 */
export function logoBacking(luminance: number): string {
  return luminance > 0.55 ? "#0f172a" : "#ffffff";
}
