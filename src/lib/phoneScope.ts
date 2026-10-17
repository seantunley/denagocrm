/**
 * WHAT THE CRM IS ON A PHONE (Sean, 2026-10-17: "The sidebar menu does not all
 * need to be available … It must be functional, but not have all the desktop
 * features, like automation").
 *
 * The phone is for people in the field — sales reps on the road, workshop
 * technicians, delivery and handover staff. Its menu keeps Sales, Workshop, the
 * help desk and deliveries; a page outside that says it is built for a computer,
 * with "Open anyway" so nobody is ever stuck. Only what is OFFERED changes —
 * permissions and the pages themselves are untouched. A phone is narrower than
 * 768px; a tablet keeps every page.
 */

/** The sections of the app a phone keeps — each with everything under it. */
export const PHONE_PATHS = [
  // Sales
  "/today", "/leads", "/deals", "/contacts", "/quotes", "/calendar", "/activities", "/test-drives",
  "/inbox", "/comments", "/signatures",
  // Workshop
  "/jobcards", "/vehicles", "/workshop-calendar", "/service-due",
  // Help desk and deliveries
  "/cases", "/deliveries",
  // Finding things and getting help
  "/search", "/help",
] as const;

/** Under a kept section, but a desktop screen all the same. */
const NOT_ON_PHONE = ["/jobcards/insights"];

/** Settings on a phone: the person's own account only. */
const PHONE_SETTINGS_TABS = new Set(["account", "notifications"]);

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Is this page part of the phone app? `tab` is the ?tab= of the address (Settings uses it). */
export function onPhone(pathname: string, tab?: string | null): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return true;
  if (NOT_ON_PHONE.some((base) => under(path, base))) return false;
  if (path === "/settings") return PHONE_SETTINGS_TABS.has(tab ?? "");
  return PHONE_PATHS.some((base) => under(path, base));
}

/** A menu link, as the phone menu decides it (its own ?tab= included). */
export function linkOnPhone(href: string): boolean {
  const [path, query = ""] = href.split("?");
  return onPhone(path, new URLSearchParams(query).get("tab"));
}
