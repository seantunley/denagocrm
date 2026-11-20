import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODULE_REGISTRY, OPTIONAL_MODULE_IDS } from "../src/lib/modules/registry";
import { buildNav } from "../src/components/nav-config";

// Sean, 2026-11-20: "I think it needs its own module now" — a switchable Email signatures pack with its own page.
// Off: emails keep exactly today's automatic signature (saved design included), with no banners.

const src = (f: string) => readFileSync(f, "utf8");

test("the pack: optional, its page and the banners' settings page are its routes", () => {
  const pack = MODULE_REGISTRY.find((m) => m.id === "signatures");
  assert.ok(pack && !pack.mandatory);
  assert.ok(OPTIONAL_MODULE_IDS.includes("signatures"));
  assert.deepEqual(pack.routePrefixes, ["/email-signatures", "/settings/signature-banners"]);
});

test("off: no banners on any email — the one check every sender path goes through; the signature itself is unchanged", () => {
  const store = src("src/lib/signatureBannerStore.ts");
  const fn = store.slice(store.indexOf("export async function bannersForSender"), store.indexOf("export async function bannersForSender") + 600);
  assert.match(fn, /if \(!\(await isModuleEnabled\("signatures"\)\)\) return \[\];/);
  // Composer and quote emails reach banners only through bannersForSender (bannerForEmail / emailWithBanner / the list).
  assert.doesNotMatch(src("src/lib/composerSend.ts"), /signatureBanner\.findMany/);
  assert.doesNotMatch(src("src/app/actions/quoteEmail.ts"), /signatureBanner\.findMany/);
  // The signature is NOT gated: off, everyone keeps the automatic one.
  for (const f of ["src/lib/composerSend.ts", "src/app/actions/quoteEmail.ts"]) assert.doesNotMatch(src(f), /isModuleEnabled\("signatures"\)/, f);
});

test("the page and Settings: one section in both places; Settings points to the page while the pack is on", () => {
  const page = src("src/app/(app)/email-signatures/page.tsx");
  assert.match(page, /const user = await requireUser\(\);/);
  assert.match(page, /canEditDesign=\{isOwner\}/);
  assert.match(page, /bannersHref=\{isOwner \? "\/settings\/signature-banners" : null\}/);
  const settings = src("src/app/(app)/settings/page.tsx");
  assert.match(settings, /const signaturesOn = enabled\.has\("signatures"\);/);
  assert.match(settings, /\{signaturesOn \? \([\s\S]*?href="\/email-signatures"[\s\S]*?\) : \([\s\S]*?<EmailSignatureSection[^>]*bannersHref=\{null\}/);
  assert.doesNotMatch(settings, /<SignatureDesignEditor/, "only through the shared section");
});

test("menu: the owner's Admin link, only while the pack is on; staff reach theirs from Settings", () => {
  const links = (admin: boolean, modules: string[]) => {
    const nav = buildNav(admin, [], new Set(["core", ...modules]));
    return [...nav.topLinks, ...nav.groups.flatMap((g) => g.links)].map((l) => l.href);
  };
  assert.ok(links(true, ["signatures"]).includes("/email-signatures"));
  assert.ok(!links(true, []).includes("/email-signatures"), "pack off: no link");
  assert.ok(!links(false, ["signatures"]).includes("/email-signatures"), "staff: from Settings → My account");
});
