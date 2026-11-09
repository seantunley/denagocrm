/**
 * The deal file as one password-protected ZIP (Sean, 2026-11-09): AES-256, with a password the person types for
 * each download and the CRM never keeps. Pure — names, the password rule and the text the cover sheet can print.
 */

export const ZIP_PASSWORD_MIN = 10;
export const ZIP_PASSWORD_MAX = 128;

/** Why this password won't do, or null. Typed twice, so a typo can't lock the recipient (and you) out. */
export function zipPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < ZIP_PASSWORD_MIN) return `Use at least ${ZIP_PASSWORD_MIN} characters.`;
  if (password.length > ZIP_PASSWORD_MAX) return `Use at most ${ZIP_PASSWORD_MAX} characters.`;
  // Not a secret check: both are what this person just typed, in their own browser and request — nothing stored is
  // compared, so there is no prefix to leak. (secretEquals is Node-only; this also runs in the browser.)
  // eslint-disable-next-line no-restricted-syntax
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}

/** A file or folder name every unzip tool accepts: no path separators or reserved characters, not too long. */
export function safeName(name: string, fallback = "file"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 120) return cleaned;
  // Keep the extension when shortening.
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length).trim() + ext;
}

/**
 * Paths inside the ZIP, in order: "folder/name". Two files of the same name in one folder become "name (2).pdf" —
 * case-insensitively, as Windows would otherwise overwrite one with the other on extraction.
 */
export function zipPaths(entries: { folder: string | null; name: string }[]): string[] {
  const taken = new Set<string>();
  return entries.map(({ folder, name }) => {
    // "Q-1025/Handover photos": each level cleaned on its own, so a nested folder stays nested and nothing escapes it.
    const dir = folder ? `${folder.split("/").map((level) => safeName(level, "folder")).join("/")}/` : "";
    const base = safeName(name);
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    let path = `${dir}${base}`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${dir}${stem} (${n})${ext}`;
    taken.add(path.toLowerCase());
    return path;
  });
}

export const dealZipFileName = (quoteNumber: number): string => `Deal file Q-${quoteNumber}.zip`;

/**
 * Text the cover sheet's built-in PDF font can draw (WinAnsi). Common typography is mapped; anything else becomes
 * "?" rather than failing the whole download over one character in a customer's name.
 */
export function winAnsi(text: string): string {
  return text
    .replace(/[→➔]/g, "->")
    .replace(/[✓✔]/g, "x")
    .replace(/−/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, "?");
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
