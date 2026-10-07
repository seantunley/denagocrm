import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BANNER_HEIGHT, BANNER_WIDTH } from "../src/lib/signatureBanner";
import {
  buildEmailHtml,
  buildSignature,
  DEFAULT_SIGNATURE_DESIGN,
  parseSignatureDesign,
  signatureCompanyFrom,
  SIGNATURE_LINE_MAX,
} from "../src/lib/signature";
import { SIGNATURE_ASSETS, signatureAsset } from "../src/lib/signatureAssets";
import { inlineImages, workspaceLogoLoader } from "../src/lib/emailInlineLogo";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const profile = {
  name: "Denago Cape Town",
  tagline: "Authorized Denago EV Dealer",
  address: "Unit 55, M5 Freeway Business Park, Maitland, Cape Town",
  phone: "073 789 3438",
  email: "sales@example.co.za",
  website: "denagocpt.co.za",
  facebook: "",
  instagram: "",
  logoUrl: "https://crm.example.co.za/branding/logo.png",
};
type User = { name: string; email: string; mobile?: string | null; jobTitle?: string | null; signatureHtml?: string | null };
const user: User = { name: "Sean Tunley", email: "sean@example.co.za", mobile: null, jobTitle: null };
const card = (design = DEFAULT_SIGNATURE_DESIGN, p = profile, u: User = user) =>
  buildSignature(u, signatureCompanyFrom(p, "https://crm.example.co.za", design));

test("the stored design is read tolerantly: anything bad is the card design, never a broken signature", () => {
  assert.deepEqual(parseSignatureDesign(null), DEFAULT_SIGNATURE_DESIGN);
  assert.deepEqual(parseSignatureDesign("{not json"), DEFAULT_SIGNATURE_DESIGN);
  assert.equal(parseSignatureDesign('{"style":"weird"}').style, "card");
  assert.equal(parseSignatureDesign('{"style":"classic"}').style, "classic");
  const long = parseSignatureDesign(JSON.stringify({ companyLine: `  ${"x".repeat(500)}  `, footerLine: 42 }));
  assert.equal(long.companyLine.length, SIGNATURE_LINE_MAX);
  assert.equal(long.footerLine, "");
});

test("the card: name, company in capitals, the three contacts and the address line — all from the profile", () => {
  const html = card();
  assert.match(html, />Sean Tunley</);
  assert.match(html, />DENAGO CAPE TOWN</);
  assert.match(html, /href="tel:0737893438"[^>]*>073 789 3438</, "the company number when the person has no mobile");
  assert.match(html, /href="mailto:sean%40example\.co\.za"/);
  assert.match(html, /href="https:\/\/denagocpt\.co\.za"[^>]*>denagocpt\.co\.za</);
  assert.match(html, /Authorized Denago EV Dealer — Unit 55, M5 Freeway Business Park/);
  for (const icon of ["phone", "mail", "web", "pin", "slant"]) {
    assert.match(html, new RegExp(`src="https://crm\\.example\\.co\\.za/branding/signature/${icon}\\.png"`));
    assert.ok(existsSync(new URL(`../public/branding/signature/${icon}.png`, import.meta.url)), `${icon}.png ships`);
  }
});

test("the person's own mobile and title win; the owner's lines replace the profile's and are escaped", () => {
  const html = card(
    { ...DEFAULT_SIGNATURE_DESIGN, companyLine: "Sales", footerLine: "<b>Open</b> Mon–Sat" },
    profile,
    { ...user, mobile: "082 000 0000", jobTitle: "Owner" },
  );
  assert.match(html, />082 000 0000</);
  assert.doesNotMatch(html, /073 789 3438/);
  assert.match(html, />OWNER&nbsp;&nbsp;·&nbsp;&nbsp;SALES</);
  assert.match(html, /&lt;b&gt;Open&lt;\/b&gt; Mon–Sat/);
  assert.doesNotMatch(html, /<b>Open/);
});

test("the mock-up's layout: a large name, and the contacts stacked in three rows, each icon · bar · value", () => {
  const html = card();
  assert.match(html, /font-size:28px;font-weight:800;[^"]*">Sean Tunley</);
  const rows = html.match(/<tr>\s*<td[^>]*><img src="[^"]+\/branding\/signature\/(phone|mail|web)\.png"[^>]*\/><\/td>\s*<td[^>]*><div style="width:1px;/g) ?? [];
  assert.equal(rows.length, 3, "phone, email and website, one row each with its bar");
});

test("the logo panel banner: shown at its size and linked, https only, and kept by a plain Save", () => {
  const bannerUrl = "https://blob.example.com/uploads/t1/public/banner.png";
  const html = card({ ...DEFAULT_SIGNATURE_DESIGN, bannerUrl });
  assert.match(html, new RegExp(`<a href="https://denagocpt\\.co\\.za"[^>]*><img class="sig-banner" src="${bannerUrl.replace(/\./g, "\\.")}"[^>]*width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}"`));
  assert.doesNotMatch(html, /slant\.png/, "the banner replaces the HTML-built panel");
  for (const bad of ["http://x.com/a.png", "javascript:alert(1)", 'https://x.com/a.png" onerror="x', "data:image/png;base64,AAAA"]) {
    assert.equal(parseSignatureDesign(JSON.stringify({ bannerUrl: bad })).bannerUrl, "", bad);
  }
  assert.equal(parseSignatureDesign(JSON.stringify({ bannerUrl })).bannerUrl, bannerUrl);
  const action = readFileSync(new URL("../src/app/actions/emails.ts", import.meta.url), "utf8");
  const save = action.slice(action.indexOf("export async function saveSignatureDesign"), action.indexOf("const storedSignatureDesign"));
  assert.match(save, /bannerUrl: \(await storedSignatureDesign\(tenantId\)\)\.bannerUrl/, "Save for everyone must not drop the banner");
  const upload = action.slice(action.indexOf("export async function saveSignatureBanner"));
  assert.match(upload, /requireTenantOwner\(\)/);
  assert.match(upload, /\["image\/png", "image\/jpeg"\]\.includes\(file\.type\)/);
  assert.match(upload, /savePublicAsset\(/, "email artwork is a public asset, never a private client file");
});

test("phones stack the panel above the details", () => {
  const page = buildEmailHtml("", card({ ...DEFAULT_SIGNATURE_DESIGN, bannerUrl: "https://blob.example.com/b.png" }));
  assert.match(page, /@media \(max-width: 600px\)[\s\S]*\.sig-panel \{ display: block !important/);
  assert.match(page, /class="sig-panel"/);
  assert.match(page, /class="sig-details"/);
});

test("an unset field removes its part: no logo, no panel; no website, no web icon", () => {
  const html = card(DEFAULT_SIGNATURE_DESIGN, { ...profile, logoUrl: "", website: "" });
  assert.doesNotMatch(html, /slant\.png|web\.png|border-left:5px/);
  assert.match(html, />Sean Tunley</);
});

test("classic stays available, and a person's own HTML still replaces the design", () => {
  assert.doesNotMatch(card({ ...DEFAULT_SIGNATURE_DESIGN, style: "classic" }), /branding\/signature\//);
  assert.equal(card(DEFAULT_SIGNATURE_DESIGN, profile, { ...user, signatureHtml: "<p>mine</p>" }), "<p>mine</p>");
});

test("the five card images travel inside the email; nothing else matches, and the open pixel stays remote", async () => {
  for (const name of Object.keys(SIGNATURE_ASSETS)) {
    const file = readFileSync(new URL(`../public/branding/signature/${name}.png`, import.meta.url));
    assert.ok(signatureAsset(`/branding/signature/${name}.png`)?.equals(file), `${name}: embedded bytes = public file`);
  }
  assert.deepEqual(Object.keys(SIGNATURE_ASSETS).sort(), ["mail", "phone", "pin", "slant", "web"]);
  for (const bad of ["/branding/signature/evil.png", "/branding/signature/../logo.png", "/branding/signature/phone.png.png", "/x/branding/signature/phone.png", "/branding/signature/constructor.png"]) {
    assert.equal(signatureAsset(bad), null, bad);
  }
  // No logo URL here, so the loader never reaches the database: only the card's own images are in play.
  const html = `${card(DEFAULT_SIGNATURE_DESIGN, { ...profile, logoUrl: "" })}<img src="https://crm.example.co.za/api/track/e/abcdefghijklmnopqrstuvwxyz" width="1" height="1" />`;
  const out = await inlineImages(html, workspaceLogoLoader("tenant_test"));
  assert.doesNotMatch(out.html, /branding\/signature\//, "every card image is a cid: reference");
  assert.equal(out.attachments.length, 4, "phone, mail, web and pin (no logo, so no slant)");
  assert.ok(out.attachments.every((a) => a.contentType === "image/png"));
  assert.match(out.html, /src="https:\/\/crm\.example\.co\.za\/api\/track\/e\/abcdefghijklmnopqrstuvwxyz"/, "the open pixel must stay remote");
});

test("the send and the settings preview both use the workspace's saved design", () => {
  for (const file of ["src/app/actions/emails.ts", "src/app/(app)/settings/page.tsx"]) {
    const code = src(file);
    assert.match(code, /parseSignatureDesign\(await getSetting\(SIGNATURE_DESIGN_KEY\)\)/, file);
    assert.match(code, /signatureCompanyFrom\(profile, await tenantOrigin\([^;]*\), (signatureD|d)esign\)/, file);
  }
  const action = src("src/app/actions/emails.ts");
  const save = action.slice(action.indexOf("export async function saveSignatureDesign"));
  assert.match(save, /requireTenantOwner\(\)/, "only the owner changes everyone's signature");
  assert.match(save, /logAudit\(/);
});
