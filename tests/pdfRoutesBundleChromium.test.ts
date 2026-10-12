import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * THE "PASSES EVERYWHERE, FAILS ONLY IN PRODUCTION" TRAP.
 *
 * PDFs are rendered with @sparticuz/chromium, whose browser binary is read at
 * RUNTIME. Next's tracer cannot see that read, so on Vercel the binary is only
 * in a function when next.config.ts lists its route under
 * outputFileTracingIncludes. A route that renders a PDF and is not listed dies
 * there with "…/@sparticuz/chromium/bin does not exist" — and nowhere else: a
 * dev machine and CI render with a locally installed Chrome.
 *
 * 2026-10-12: a quote DAX built arrived on WhatsApp without its PDF, because the
 * WhatsApp webhook rendered it and was not listed. "Attach quote" in the email
 * composer had the same gap on the lead and customer pages. This keeps the list
 * and the code in step.
 */

const config = readFileSync("next.config.ts", "utf8");
const includes = config.slice(config.indexOf("outputFileTracingIncludes: {"), config.indexOf("async headers()"));
const listed = [...includes.matchAll(/^\s*"([^"]+)": \[CHROMIUM_FILES\],/gm)].map((m) => m[1]);
/** Is this route covered by an entry — exactly, or by an entry ending in /** ? */
const covered = (route: string) => listed.some((entry) => entry === route || (entry.endsWith("/**") && (route === entry.slice(0, -3) || route.startsWith(entry.slice(0, -2)))));

test("the routes that began rendering a quote PDF on 2026-10-12 are bundled with the PDF engine", () => {
  for (const route of ["/api/webhooks/whatsapp", "/api/cron/assistant", "/leads/abc", "/contacts/abc", "/assistant"]) {
    assert.ok(covered(route), `${route} renders a quote PDF and is not listed in outputFileTracingIncludes`);
  }
  // The older ones are still there.
  for (const route of ["/quotes/abc", "/jobcards/abc", "/document-studio", "/signatures/abc", "/api/signing/abc", "/api/sign/abc"]) {
    assert.ok(covered(route), route);
  }
  assert.match(config, /serverExternalPackages: \["@sparticuz\/chromium", "puppeteer-core"\]/);
});

const files = (dir: string, match: RegExp): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, match) : match.test(name) ? [path] : [];
  });
/** src/app/(app)/leads/[id]/page.tsx → /leads/[id] ; src/app/api/x/route.ts → /api/x */
const routeOf = (file: string) =>
  "/" + file.replace(/\\/g, "/").replace(/^src\/app\//, "").replace(/\/(page\.tsx|route\.ts)$/, "").split("/").filter((part) => !/^\(.*\)$/.test(part)).join("/");

test("every API route that can deliver a built quote's PDF is listed", () => {
  // The PDF is sent by the assistant's update sender. Any route handler that reaches it —
  // by handling a staff WhatsApp message, or by sweeping waiting updates — renders PDFs.
  const reaching = files("src/app/api", /^route\.ts$/).filter((file) => /handleStaffWhatsApp|sweepWaitingUpdates|sendUpdatesToLinkedPhone/.test(readFileSync(file, "utf8")));
  assert.ok(reaching.length >= 2, "the webhook and the cron tick, at least");
  for (const file of reaching) assert.ok(covered(routeOf(file)), `${routeOf(file)} can send a quote PDF and is not listed in outputFileTracingIncludes`);
});

test("every page that hosts the email composer (Attach quote renders the PDF there) is listed", () => {
  const hosting = files("src/app", /^page\.tsx$/).filter((file) => /<EmailComposer\b/.test(readFileSync(file, "utf8")));
  assert.ok(hosting.length >= 2, "the lead page and the customer page, at least");
  for (const file of hosting) assert.ok(covered(routeOf(file)), `${routeOf(file)} hosts the email composer and is not listed in outputFileTracingIncludes`);
});
