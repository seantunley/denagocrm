import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inlineImages, readCapped, type ImageLoader } from "../src/lib/emailInlineLogo";

// Mail clients block remote images until the reader allows them, so a linked
// logo arrived as a broken-image box. The workspace's logo is now embedded as a
// cid attachment; everything else in the email is left as it was.
const LOGO = "https://crm.example.com/api/brand/logo/t1?a=logo-1.png";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const loader: ImageLoader = async (src) => (src === LOGO ? { content: png, contentType: "image/png" } : null);

test("the workspace logo becomes a cid attachment, escaped & and all", async () => {
  // escapeHtml() writes & as &amp; inside the attribute.
  const html = `<p><img src="${LOGO.replace("&", "&amp;")}" alt="Co"></p><img src="${LOGO}" height="26">`;
  const out = await inlineImages(html, loader);
  assert.equal(out.attachments.length, 1, "one attachment however often it appears");
  assert.equal(out.attachments[0].cid, "logo1@inline");
  assert.equal(out.attachments[0].filename, "logo1.png");
  assert.equal(out.attachments[0].contentType, "image/png");
  assert.doesNotMatch(out.html, /api\/brand\/logo/);
  assert.equal(out.html.match(/src="cid:logo1@inline"/g)?.length, 2);
});

test("other images — the tracking pixel, data URIs, http — are untouched", async () => {
  const html = `<img src="https://crm.example.com/api/track/o/abc" width="1"><img src="data:image/png;base64,AAAA"><img src="http://x/y.png">`;
  const out = await inlineImages(html, loader);
  assert.equal(out.html, html);
  assert.equal(out.attachments.length, 0);
});

test("a loader failure leaves the linked logo, never fails the email", async () => {
  const html = `<img src="${LOGO}">`;
  const out = await inlineImages(html, async () => { throw new Error("storage down"); });
  assert.equal(out.html, html);
  assert.equal(out.attachments.length, 0);
});

test("only this workspace's own logo is loaded, and sendEmail never fails over it", () => {
  const lib = readFileSync(new URL("../src/lib/emailInlineLogo.ts", import.meta.url), "utf8");
  // Brand route: this tenant's path only, bytes from storage (no fetch of the URL).
  assert.match(lib, /if \(url\.pathname === `\/api\/brand\/logo\/\$\{tenantId\}`\) \{/);
  assert.match(lib, /await readManagedBlob\(`branding\/\$\{tenantId\}\/\$\{asset\}`\)/);
  // Company Profile logo: exactly the URL configured for this workspace, never private.
  assert.match(lib, /if \(!configured \|\| configured !== src \|\| /);
  assert.match(lib, /redirect: "error"/);
  assert.match(lib, /contentType\.startsWith\("image\/"\)/);
  const email = readFileSync(new URL("../src/lib/email.ts", import.meta.url), "utf8");
  // The workspace the mail is SENT AS, not a second read of ambient scope (review of #744).
  assert.match(email, /await inlineImages\(input\.html, workspaceLogoLoader\(config\.tenantId\)\)\.catch\(\(\) => null\)/);
  assert.match(email, /html: inline\?\.html \?\? input\.html,/);
  // The size cap is enforced before and while reading, never after buffering.
  assert.doesNotMatch(lib, /arrayBuffer\(\)/);
  assert.match(lib, /if \(Number\(response\.headers\.get\("content-length"\) \?\? 0\) > MAX_LOGO_BYTES\) \{/);
  assert.match(lib, /const content = await readCapped\(response\.body, MAX_LOGO_BYTES\);/);
});

test("an over-size download is cut off at the cap, not read to the end", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1000));
      if (pulled > 10_000) controller.close();
    },
  });
  assert.equal(await readCapped(endless, 5000), null);
  assert.ok(pulled < 20, `stopped after ${pulled} chunks, not the whole stream`);

  const small = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
  });
  assert.deepEqual([...((await readCapped(small, 5000)) ?? [])], [1, 2, 3]);
});
