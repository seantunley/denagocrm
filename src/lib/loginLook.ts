/**
 * THE SIGN-IN SCREEN, PER WORKSPACE (Sean, 2026-11-23: "I want the login screen fully customizable"). Every word on it,
 * and what the right-hand side shows: the dashboard card, the workspace's own picture in its place, or nothing — over
 * the standard backdrop or the workspace's own background photo.
 *
 * Stored as one JSON value on Tenant.loginJson, edited by the workspace owner (Settings → Company profile) or a
 * platform admin (console). Pure — no server or React imports — so the page, the editor's live preview, the save
 * action and the tests all read it the same way.
 *
 * UNTRUSTED AT BOTH ENDS: the sign-in page is public, so every value is re-checked on read (parseLoginLook), not only
 * on save. Text is plain text (React escapes it; control characters stripped, lengths capped); the two pictures are
 * stored as bare file names of one strict shape and served only through /api/brand/login-image.
 *
 * DEFAULTS ARE TODAY'S PAGE: nothing changes for any workspace until someone edits it.
 */

export type LoginBackground = "standard" | "image";
export type LoginCard = "dashboard" | "image" | "none";

export type LoginLook = {
  eyebrow: string;
  heading: string;
  /** "{name}" is replaced with the workspace's name. */
  subheading: string;
  buttonLabel: string;
  /** Top-right chip. Blank hides it. */
  badge: string;
  /** "Operations online" over the right-hand side. Blank hides it. */
  status: string;
  headline: string;
  headlineSoft: string;
  /** The line under the headline. Blank uses the workspace's tagline. */
  subline: string;
  background: LoginBackground;
  /** File name of the workspace's own background photo (login-bg-<stamp>.<ext>), when background is "image". */
  backgroundImage: string | null;
  card: LoginCard;
  /** File name of the picture shown in the card's place (login-card-<stamp>.<ext>), when card is "image". */
  cardImage: string | null;
  cardEyebrow: string;
  cardTiles: [string, string, string];
  /** The illustrative figures on the tiles. Off shows the labels alone. */
  cardNumbers: boolean;
  chartLabel: string;
  /** "+18% this week". Blank hides it. */
  chartNote: string;
  /** The little note at the card's corner. A blank title hides it. */
  toastTitle: string;
  toastText: string;
};

export const LOGIN_DEFAULTS: LoginLook = {
  eyebrow: "Staff portal",
  heading: "Welcome back.",
  subheading: "Sign in to {name}.",
  buttonLabel: "Enter workspace",
  badge: "Secure access",
  status: "Operations online",
  headline: "Every lead. Every customer.",
  headlineSoft: "All in one place.",
  subline: "",
  background: "standard",
  backgroundImage: null,
  card: "dashboard",
  cardImage: null,
  cardEyebrow: "Today’s pulse",
  cardTiles: ["Active leads", "Open quotes", "Follow-ups"],
  cardNumbers: true,
  chartLabel: "Team momentum",
  chartNote: "+18% this week",
  toastTitle: "Follow-up complete",
  toastText: "Customer journey updated",
};

/** The text fields, their limits, and whether blank is allowed (blank = hidden) or falls back to the default. */
export const LOGIN_TEXT_FIELDS = {
  eyebrow: { max: 40, blank: "hide" },
  heading: { max: 60, blank: "default" },
  subheading: { max: 120, blank: "hide" },
  buttonLabel: { max: 30, blank: "default" },
  // 40, not 30: "Fourways · Ballito · Beacon Bay" (31) was cut to "Beacon Ba" (Sean, 2026-11-24).
  badge: { max: 40, blank: "hide" },
  status: { max: 40, blank: "hide" },
  headline: { max: 80, blank: "hide" },
  headlineSoft: { max: 80, blank: "hide" },
  subline: { max: 160, blank: "hide" },
  cardEyebrow: { max: 40, blank: "hide" },
  chartLabel: { max: 40, blank: "hide" },
  chartNote: { max: 30, blank: "hide" },
  toastTitle: { max: 40, blank: "hide" },
  toastText: { max: 60, blank: "hide" },
} as const satisfies Partial<Record<keyof LoginLook, { max: number; blank: "hide" | "default" }>>;
export type LoginTextField = keyof typeof LOGIN_TEXT_FIELDS;
export const LOGIN_TILE_MAX = 24;

/** One line of plain text: control characters and line breaks become spaces, then trimmed and capped. */
export function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const IMAGE = /^login-(bg|card)-\d{10,16}\.(png|jpe?g|webp)$/i;
/** A stored picture's file name, or null for anything else (so a path can never be named). */
export function loginImageName(value: unknown, kind: "bg" | "card"): string | null {
  return typeof value === "string" && IMAGE.test(value) && value.toLowerCase().startsWith(`login-${kind}-`) ? value : null;
}

/** The saved value, checked field by field; anything missing or invalid is the default. Never throws. */
export function parseLoginLook(raw: unknown): LoginLook {
  const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const look: LoginLook = { ...LOGIN_DEFAULTS, cardTiles: [...LOGIN_DEFAULTS.cardTiles] };
  for (const [field, rule] of Object.entries(LOGIN_TEXT_FIELDS) as [LoginTextField, (typeof LOGIN_TEXT_FIELDS)[LoginTextField]][]) {
    if (!(field in saved)) continue;
    const text = cleanText(saved[field], rule.max);
    look[field] = text || (rule.blank === "hide" ? "" : LOGIN_DEFAULTS[field]);
  }
  if (Array.isArray(saved.cardTiles)) {
    look.cardTiles = [0, 1, 2].map((i) => cleanText((saved.cardTiles as unknown[])[i], LOGIN_TILE_MAX)) as [string, string, string];
  }
  if (typeof saved.cardNumbers === "boolean") look.cardNumbers = saved.cardNumbers;
  look.backgroundImage = loginImageName(saved.backgroundImage, "bg");
  look.cardImage = loginImageName(saved.cardImage, "card");
  // A choice that needs a picture it doesn't have falls back, rather than showing an empty frame.
  look.background = saved.background === "image" && look.backgroundImage ? "image" : "standard";
  look.card = saved.card === "none" ? "none" : saved.card === "image" && look.cardImage ? "image" : "dashboard";
  return look;
}

/** The sub-heading with the workspace's name in place. */
export const loginSubheading = (look: LoginLook, name: string) => look.subheading.replaceAll("{name}", name);

/** Where the sign-in page loads a workspace's picture from (public: the page is shown before sign-in). */
export function loginImageUrl(tenantId: string | null, name: string | null): string | null {
  return tenantId && name ? `/api/brand/login-image/${tenantId}?a=${encodeURIComponent(name)}` : null;
}

/** Whether a stored file name is one of this look's CURRENT pictures — the image route serves nothing else. */
export function isCurrentLoginImage(look: LoginLook, name: string): boolean {
  return name === look.backgroundImage || name === look.cardImage;
}
