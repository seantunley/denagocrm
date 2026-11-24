import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LOGIN_DEFAULTS, isCurrentLoginImage, loginImageName, loginImageUrl, loginSubheading, parseLoginLook } from "../src/lib/loginLook";

const code = (path: string) => readFileSync(path, "utf8");

test("nothing changes for a workspace that hasn't edited its sign-in screen", () => {
  assert.deepEqual(parseLoginLook(null), LOGIN_DEFAULTS);
  assert.deepEqual(parseLoginLook("not an object"), LOGIN_DEFAULTS);
  assert.deepEqual(parseLoginLook([1, 2]), LOGIN_DEFAULTS);
  // Today's page, word for word.
  assert.equal(LOGIN_DEFAULTS.eyebrow, "Staff portal");
  assert.equal(LOGIN_DEFAULTS.heading, "Welcome back.");
  assert.equal(loginSubheading(LOGIN_DEFAULTS, "Acme"), "Sign in to Acme.");
  assert.equal(LOGIN_DEFAULTS.buttonLabel, "Enter workspace");
  assert.equal(LOGIN_DEFAULTS.headline, "Every lead. Every customer.");
  assert.deepEqual(LOGIN_DEFAULTS.cardTiles, ["Active leads", "Open quotes", "Follow-ups"]);
  assert.equal(LOGIN_DEFAULTS.card, "dashboard");
});

test("saved wording is plain text, capped, and a blank either hides the line or keeps the standard one", () => {
  const look = parseLoginLook({ heading: "  Hello\u0000\nthere  ", eyebrow: "", badge: "", buttonLabel: "", status: "x".repeat(500), cardTiles: ["Jobs", "", "Bookings", "extra"] });
  assert.equal(look.heading, "Hello there", "control characters and line breaks become one space");
  assert.equal(look.eyebrow, "", "a blank small label hides it");
  assert.equal(look.badge, "", "a blank badge hides it");
  assert.equal(look.buttonLabel, "Enter workspace", "a button always has words");
  assert.equal(look.status.length, 40, "capped");
  assert.deepEqual(look.cardTiles, ["Jobs", "", "Bookings"]);
  // React escapes text; the value is never markup.
  assert.equal(parseLoginLook({ heading: "<script>alert(1)</script>" }).heading, "<script>alert(1)</script>");
});

test("a picture is only ever a strictly-shaped file name, never a path", () => {
  assert.equal(loginImageName("login-bg-1764000000000.jpg", "bg"), "login-bg-1764000000000.jpg");
  assert.equal(loginImageName("../../secrets/login-bg-1764000000000.jpg", "bg"), null);
  assert.equal(loginImageName("login-bg-1764000000000.svg", "bg"), null, "no SVG — a document that can carry script");
  assert.equal(loginImageName("login-card-1764000000000.png", "bg"), null, "a card picture can't be the background");
  assert.equal(loginImageName("logo-1764000000000.png", "bg"), null);
  assert.equal(loginImageUrl("t1", "login-bg-1764000000000.jpg"), "/api/brand/login-image/t1?a=login-bg-1764000000000.jpg");
  assert.equal(loginImageUrl(null, "login-bg-1764000000000.jpg"), null);
});

test("choosing a picture that isn't there falls back rather than showing an empty frame", () => {
  assert.equal(parseLoginLook({ background: "image" }).background, "standard");
  assert.equal(parseLoginLook({ card: "image" }).card, "dashboard");
  assert.equal(parseLoginLook({ card: "none" }).card, "none");
  const withPictures = parseLoginLook({ background: "image", backgroundImage: "login-bg-1764000000000.webp", card: "image", cardImage: "login-card-1764000000000.png" });
  assert.equal(withPictures.background, "image");
  assert.equal(withPictures.card, "image");
  assert.equal(isCurrentLoginImage(withPictures, "login-card-1764000000000.png"), true);
  assert.equal(isCurrentLoginImage(withPictures, "login-card-1700000000000.png"), false, "a replaced picture is no longer served");
});

test("the picture route serves only the workspace's current pictures, rebuilt from its own folder", () => {
  const route = code("src/app/api/brand/login-image/[tenantId]/route.ts");
  assert.match(route, /if \(!requested \|\| !isCurrentLoginImage\(look, requested\)\) return/);
  assert.match(route, /readManagedBlob\(`branding\/\$\{tenantId\}\/\$\{requested\}`\)/);
  assert.match(route, /"Content-Security-Policy": "default-src 'none'; sandbox"/);
  assert.match(code("src/proxy.ts"), /"\/api\/brand\/login-image",/, "public: the sign-in page is shown before sign-in");
});

test("saving authorises first, checks the picture's bytes, and audits in the same transaction", () => {
  const actions = code("src/app/actions/loginLook.ts");
  assert.match(actions, /export async function saveMyLoginLookAction[\s\S]*?const user = await requireTenantOwner\(\);\s*const tenantId = await actingOwnerTenantId\(\);/);
  assert.match(actions, /export async function savePlatformLoginLookAction[\s\S]*?const actor = await requirePlatformAdminAction\(\);/);
  assert.match(actions, /if \(!type \|\| !type\.magic\(bytes\)\) throw new ActionRefusal/);
  assert.doesNotMatch(actions, /image\/svg/, "no SVG pictures");
  assert.match(actions, /await tx\.tenant\.update\(\{ where: \{ id: tenantId \}, data: \{ loginJson: after \} \}\);\s*await logAuditStrict\(/);
  assert.match(actions, /return parseLoginLook\(look\);/, "stored exactly as the sign-in page will read it");
});

test("the sign-in page and the editor's preview draw from the same parts", () => {
  const page = code("src/app/login/LoginClient.tsx");
  assert.match(page, /<SignInIntro brand=\{brand\} \/>/);
  assert.match(page, /<BrandScene brand=\{brand\} \/>/);
  assert.match(page, /brand\.look\.buttonLabel/);
  const editor = code("src/components/branding/LoginLookEditor.tsx");
  assert.match(editor, /<SignInIntro brand=\{scene\} \/>/);
  assert.match(editor, /<BrandScene brand=\{scene\} preview \/>/);
  // Owners edit their own; the console edits any.
  assert.match(code("src/app/(app)/settings/company/page.tsx"), /<LoginLookEditor\s+action=\{saveMyLoginLookAction\}/);
  assert.match(code("src/app/platform/(console)/tenants/[id]/page.tsx"), /action=\{savePlatformLoginLookAction\.bind\(null, tenant\.id\)\}/);
});

test("saving business details never blanks the logo documents use", () => {
  assert.match(code("src/app/actions/company.ts"), /if \(!formData\.has\(field\)\) continue;/);
  assert.doesNotMatch(code("src/app/(app)/settings/company/page.tsx"), /name: "logoUrl"/, "the logo is an upload now");
  assert.match(code("src/app/actions/workspaceLogo.ts"), /putSetting\(COMPANY_KEYS\.logoUrl, ""\)/, "an upload replaces the old typed-in logo address");
});
