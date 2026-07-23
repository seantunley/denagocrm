export type PwaActivityShortcut = {
  cleanUrl: string;
};

/**
 * Recognises the installed-app launcher URL and returns a clean browser URL.
 * Requiring the source marker avoids opening the dialog for ordinary calendar
 * navigation that happens to use a similarly named query parameter.
 */
export function readPwaActivityShortcut(href: string): PwaActivityShortcut | null {
  let url: URL;

  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (
    url.searchParams.get("source") !== "pwa-shortcut" ||
    url.searchParams.get("quick-create") !== "activity"
  ) {
    return null;
  }

  url.searchParams.delete("source");
  url.searchParams.delete("quick-create");

  return {
    cleanUrl: `${url.pathname}${url.search}${url.hash}`,
  };
}
