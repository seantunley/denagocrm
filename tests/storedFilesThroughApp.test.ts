import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { storedFileSrc } from "../src/lib/storedFileSrc";

/**
 * Every stored file is reached THROUGH THE APP, so the store can be private.
 *
 * A file in the private Blob store has no public link. Screens that put a stored
 * ref straight into <img>/<audio>/<video>/<a>, printed documents that did the
 * same, and messages that handed WhatsApp/Messenger/Telegram a raw link would all
 * have broken the moment new uploads went private. Each now goes through a route
 * that checks the viewer, an embedded image, or a short-lived signed link.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

/* ── the browser link ─────────────────────────────────────────────── */

test("OUR STORED FILES GO THROUGH /api/stored; everything else is untouched", () => {
  const pub = "https://dsvd1rq8etdsnlzs.public.blob.vercel-storage.com/uploads/t1/photo.jpg";
  const priv = "https://nck7vgytz70fz8l8.private.blob.vercel-storage.com/uploads/t1/photo.jpg";
  assert.equal(storedFileSrc(pub), `/api/stored?ref=${encodeURIComponent(pub)}`);
  assert.equal(storedFileSrc(priv), `/api/stored?ref=${encodeURIComponent(priv)}`);
  assert.equal(storedFileSrc("3f2b9c1e-8a4d.jpg"), "/api/stored?ref=3f2b9c1e-8a4d.jpg", "a local dev upload");
  for (const untouched of [
    "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", // a provider's own link
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:http://localhost:4000/1234", // an in-browser preview
    "/branding/denago-logo-email.png",
    "https://example.com/brochure.png",
  ]) {
    assert.equal(storedFileSrc(untouched), untouched, untouched);
  }
  assert.equal(storedFileSrc(null), null);
  assert.equal(storedFileSrc(""), null);
});

test("NO SCREEN PUTS A STORED-FILE FIELD STRAIGHT INTO src OR href", () => {
  // The fields that hold stored-file refs. A new screen that renders one raw
  // fails here, before it can break the day files are private.
  const FIELD = /\b(attachmentUrl|storedName|annotatedStoredName|photoStoredName|signatureRef|dealerSignatureRef|deliverySignatureRef|drawnSignatureRef|avatarRef|brandLogoRef|signedPdfRef|unsignedPdfRef|storageRef|photo\.url)\b/;
  const offenders: string[] = [];
  for (const file of files(path.join(root, "src"), /\.tsx$/)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(src|href)=\{([^}]*)\}/g)) {
      if (FIELD.test(m[2]) && !m[2].includes("storedFileSrc(")) {
        offenders.push(`${path.relative(root, file)}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `raw stored-file links:\n  ${offenders.join("\n  ")}`);
});

test("the screens that showed raw links now use storedFileSrc", () => {
  for (const file of [
    "src/components/CommsTimeline.tsx",
    "src/components/SocialThreadList.tsx",
    "src/components/checklists/ChecklistCard.tsx",
    "src/components/checklists/ChecklistRunner.tsx",
  ]) {
    assert.match(src(file), /storedFileSrc\((c|message|photo)\.(attachmentUrl|url)\)/, file);
  }
  assert.match(src("src/components/LeadTimeline.tsx"), /image: storedFileSrc\(communication\.attachmentUrl\)/);
});

/* ── the route ────────────────────────────────────────────────────── */

test("/api/stored: signed in, the viewer's own workspace, never cached, never HTML", () => {
  const route = src("src/app/api/stored/route.ts");
  assert.match(route, /await requireApiUser\(\);/);
  assert.match(route, /if \(!isStoredFileRef\(ref\)\) return/);
  assert.match(route, /tenantId = await withActingStaffScope\(\(\) => actingTenantId\(\)\);/);
  assert.match(route, /await openStoredFile\(ref, tenantId\)/, "the owner check readFile makes, against the acting workspace");
  assert.match(route, /"Cache-Control": "private, no-store"/);
  const inline = route.match(/const INLINE = (\/.*\/i);/)?.[1] ?? "";
  assert.ok(inline && !/svg|html/i.test(inline), "SVG and HTML never render inline");
});

test("backups download through an owner-only route, backups/ objects only", () => {
  // Not under api/backups/: .gitignore ignores every `backups/` directory, so a
  // route there is silently never committed and the link 404s in production.
  const route = src("src/app/api/backup-file/route.ts");
  assert.match(route, /await requireApiOwner\(\);/);
  assert.match(route, /!pathname\.startsWith\("backups\/"\)/);
  assert.match(src("src/app/(app)/settings/backup-recovery/page.tsx"), /href=\{`\/api\/backup-file\?ref=\$\{encodeURIComponent\(blob\.url\)\}`\}/);
});

/* ── printed documents, outside services, public assets ───────────── */

test("printed signatures and template logos are embedded, not linked", () => {
  assert.match(src("src/lib/docTemplateStore.ts"), /logoUrl: await embedStoredImage\(tpl\.logoUrl, tenantId\)/);
  const jobcard = src("src/app/(print)/jobcards/[id]/print/page.tsx");
  assert.match(jobcard, /await embedStoredImage\(jobCard\.signatureRef, jobCard\.tenantId\)/);
  assert.match(jobcard, /<img src=\{signatureSrc\}/);
});

test("WhatsApp, Messenger and Telegram get a link they can fetch", () => {
  assert.match(src("src/lib/whatsapp.ts"), /image: \{ link: await shareableFileUrl\(url\)/);
  assert.match(src("src/lib/messenger.ts"), /payload: \{ url: await shareableFileUrl\(attachment\.url\)/);
  assert.match(src("src/lib/telegramTransport.ts"), /photo: await shareableFileUrl\(url\)/);
  const storage = src("src/lib/storage.ts");
  assert.match(storage, /issueSignedToken\(\{ pathname, operations: \["get"\], validUntil, token \}\)/, "scoped to one object, read-only");
  assert.match(storage, /const SHARE_LINK_TTL_MS = 60 \* 60 \* 1000;/);
});

test("a link that isn't one of our files is shared as it is", async () => {
  const before = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
  delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
  try {
    const { shareableFileUrl } = await import("../src/lib/storage");
    assert.equal(await shareableFileUrl("https://example.com/a.png"), "https://example.com/a.png");
    const pub = "https://dsvd1rq8etdsnlzs.public.blob.vercel-storage.com/uploads/t1/a.png";
    assert.equal(await shareableFileUrl(pub), pub, "no private store: a public file is already fetchable");
  } finally {
    if (before !== undefined) process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = before;
  }
});

test("campaign and bot-flow images are public on purpose, under a path the migration skips", () => {
  assert.match(src("src/app/actions/campaigns.ts"), /return savePublicAsset\(buf, file\.name, file\.type, tenantId\);/);
  assert.match(src("src/lib/storage.ts"), /put\(`uploads\/\$\{tenantId\}\/public\/\$\{crypto\.randomUUID\(\)\}\$\{ext\}`/);
});

test("with a private store, the browser is never redirected to a public link", async () => {
  // The migration keeps paths and deletes the public copy, so a redirect to the
  // public link would 404. The app reads private-first instead.
  const { directReadUrl } = await import("../src/lib/storage");
  const pub = "https://dsvd1rq8etdsnlzs.public.blob.vercel-storage.com/uploads/t1/sig.png";
  const before = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
  try {
    delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
    assert.equal(directReadUrl(pub), pub, "no private store: the public link is fine");
    process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    assert.equal(directReadUrl(pub), null, "private store: stream through the app");
  } finally {
    if (before === undefined) delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
    else process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = before;
  }
});

test("deleting a public link also deletes its migrated private copy", () => {
  assert.match(
    src("src/lib/storage.ts"),
    /if \(!isPrivateBlobRef\(ref\) && privateToken\(\)\) \{\s*await del\(new URL\(ref\)\.pathname\.replace\(\/\^\\\/\+\/, ""\), \{ token: privateToken\(\) \}\);/,
  );
});
