import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { SCREENS_WITHOUT_HELP, SCREEN_HELP_SLUGS, helpSlugForScreen } from "../src/lib/help/screenHelp";
import { getArticle } from "../src/lib/help/content";

const APP = "src/app/(app)";

/** Every staff screen: each page.tsx under (app), as a URL ("[id]" → a sample id). */
function screens(dir = APP, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("@") || name.startsWith("(")) continue; // parallel and grouped routes render inside another screen
    const segment = name.startsWith("[") ? "sample-id" : name;
    const route = `${prefix}/${segment}`;
    if (readdirSync(full).includes("page.tsx")) found.push(route);
    found.push(...screens(full, route));
  }
  return found;
}

const excused = (route: string) => Object.keys(SCREENS_WITHOUT_HELP).some((skip) => route === skip || route.startsWith(`${skip}/`));

test("every staff screen has a guide behind its '?', or a written reason why not", () => {
  const missing = screens().filter((route) => !excused(route) && !helpSlugForScreen(route));
  assert.deepEqual(missing, [], "map these in lib/help/screenHelp.ts, or list them in SCREENS_WITHOUT_HELP with a reason");
});

test("every guide the '?' opens is a real article", () => {
  assert.deepEqual(SCREEN_HELP_SLUGS.filter((slug) => !getArticle(slug)), []);
});

test("the right guide for the screen", () => {
  assert.equal(helpSlugForScreen("/"), "home-screen");
  assert.equal(helpSlugForScreen("/quotes"), "quotes-overview");
  assert.equal(helpSlugForScreen("/quotes/abc123"), "quotes-send-revise-lock", "a record has its own guide");
  assert.equal(helpSlugForScreen("/leads/new"), "leads-create-a-lead", "an exact screen beats the record pattern");
  assert.equal(helpSlugForScreen("/settings/sessions/"), "admin-sessions-devices", "a trailing slash doesn't matter");
  assert.equal(helpSlugForScreen("/settings", "?tab=account"), "admin-my-account-profile", "a settings tab has its own");
  assert.equal(helpSlugForScreen("/settings", "?tab=nonsense"), "admin-settings-overview");
  // A record's sub-page falls back to the screen above it — never to the Home guide.
  assert.equal(helpSlugForScreen("/jobcards/abc/print"), "jobcards-workflow-stages");
  // The screens whose guides came with the help review.
  assert.equal(helpSlugForScreen("/invoices"), "invoices-overview");
  assert.equal(helpSlugForScreen("/settings/vendors"), "suppliers");
  assert.equal(helpSlugForScreen("/settings/clock-weather"), "clock-and-weather");
  assert.equal(helpSlugForScreen("/help/welcome"), null);
  assert.equal(helpSlugForScreen("/no-such-screen"), null);
});

test("the panel is in the top bar on every screen, and loads one guide at a time for signed-in staff", () => {
  const shell = readFileSync("src/components/AppShell.tsx", "utf8");
  assert.match(shell, /<ScreenHelp \/>\s*<SidebarHelpSettings/);
  const route = readFileSync("src/app/api/help/[slug]/route.ts", "utf8");
  assert.match(route, /if \(!\(await getCurrentUser\(\)\)\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/);
  assert.match(route, /isArticleEnabled\(article, enabled\)/, "a switched-off module's guide stays hidden, as on /help");
  // The whole Help Centre must not ship to the browser with the top bar.
  assert.doesNotMatch(readFileSync("src/components/help/ScreenHelp.tsx", "utf8"), /lib\/help\/content/);
});
