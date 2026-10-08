import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emailBlockPreviewHtml, emailFramePreview, renderEmailDocument, type EmailBrand } from "../src/lib/doceditor/emailRender";
import { defaultEmailBody, defaultEmailFrame, EMAIL_KINDS, isUntouchedEmailSeed } from "../src/lib/doceditor/emailDefaults";
import { STANDARD_WORDING_2026_10_07, STANDARD_WORDING_2026_10_08 } from "../src/lib/doceditor/emailWordingHistory";
import { documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";
import { SIGNING_EMAILS, type SigningEmailKind } from "../src/lib/signing/emailTemplates";

/*
 * Sean, 2026-10-08, on the email designer:
 *   "It must be the senders information"           — the signature
 *   "Where is the header, footer? So I can't style those things?"
 *   "Send a quote to sign that they can't decline is not good"
 *   "Why do these still exist?"                     — emails listed as builder layouts
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const brand: EmailBrand = {
  companyName: "Acme Carts", tagline: "Dealer", address: "1 Main Rd, Cape Town", phone: "021 000 0000", email: "hi@acme.example",
  website: "acme.example", logoUrl: "https://acme.example/logo.png", bannerUrl: "", accent: "#f1603c", assetBase: "https://crm.acme.example",
};
const PAT = { sender_name: "Pat Smith", sender_title: "Sales Manager", sender_mobile: "082 555 0101", sender_email: "pat@acme.example" };
const fieldsFor = (kind: SigningEmailKind, over: Record<string, string>) =>
  Object.fromEntries(SIGNING_EMAILS[kind].fields.map((f) => [f, over[f] ?? ""]));

type Block<T extends DocumentBlock["type"]> = Extract<DocumentBlock, { type: T }>;
/** The standard frame with one of its blocks (or its colours) changed — through the schema, as a saved frame is. */
function frameWith(patch: { header?: Partial<Block<"emailHeader">>; signature?: Partial<Block<"emailSignature">>; footer?: Partial<Block<"emailFooter">>; email?: NonNullable<DocumentModel["email"]> }): DocumentModel {
  const frame = defaultEmailFrame();
  for (const row of frame.pages[0].rows) {
    const block = row.columns[0].blocks[0];
    if (block.type === "emailHeader") Object.assign(block, patch.header);
    if (block.type === "emailSignature") Object.assign(block, patch.signature);
    if (block.type === "emailFooter") Object.assign(block, patch.footer);
  }
  return documentSchema.parse({ ...frame, ...(patch.email ? { email: patch.email } : {}) });
}
const render = (kind: SigningEmailKind, frame: DocumentModel, fields: Record<string, string>) =>
  renderEmailDocument({ frame, body: defaultEmailBody(kind), fields: fieldsFor(kind, fields), brand, action: SIGNING_EMAILS[kind].action ?? null });

test("the signature is the SENDER's: their name, job title, mobile and email — not the company's", () => {
  const { html, text } = render("quote", defaultEmailFrame(), { ...PAT, quote_number: "Q-42" });
  const signature = html.slice(html.indexOf(">Pat Smith<"));
  assert.match(signature, /SALES MANAGER/);
  assert.match(signature, /ACME CARTS/, "the company, under the person");
  assert.match(signature, /082 555 0101/);
  assert.match(signature, /mailto:pat%40acme\.example/);
  assert.doesNotMatch(signature.slice(0, signature.indexOf("border-top:1px solid #eef0f3")), /021 000 0000|hi@acme\.example/, "the company's number and address are the footer's, not the signature's");
  assert.match(text, /--\nPat Smith\nSales Manager\nAcme Carts\n082 555 0101 · pat@acme\.example · acme\.example/);
});

test("a sender with no mobile falls back to the company's number; an automatic message is signed by the company, once", () => {
  const noMobile = render("quote", defaultEmailFrame(), { ...PAT, sender_mobile: "" }).html;
  assert.match(noMobile.slice(noMobile.indexOf(">Pat Smith<")), /021 000 0000/);
  // A service reminder has no sender: nobody's name is invented, and the company is not named twice.
  const auto = render("service_reminder", defaultEmailFrame(), { first_name: "Jo", model: "Rover XL" }).html;
  assert.doesNotMatch(auto, /Pat Smith/);
  const signature = auto.slice(auto.lastIndexOf(">Acme Carts<"));
  assert.match(signature, /021 000 0000/);
  assert.match(signature, /mailto:hi%40acme\.example/);
  assert.doesNotMatch(signature.slice(0, signature.indexOf("021 000 0000")), /ACME CARTS/, "no company line repeating the name above it");
});

test("every person-sent email carries the sender's fields; the send paths fill them from the sender's own account", () => {
  for (const kind of ["invite", "reminder", "completed", "otp", "quote"] as const) {
    for (const f of ["sender_name", "sender_title", "sender_mobile", "sender_email"]) {
      assert.ok((SIGNING_EMAILS[kind].fields as readonly string[]).includes(f), `${kind}: ${f}`);
    }
  }
  const signing = src("src/lib/signing/signingEmail.ts");
  assert.match(signing, /select: \{ name: true, email: true, mobile: true, jobTitle: true \}/);
  assert.match(signing, /vars\.sender_mobile = sender\?\.mobile \?\? "";/);
  const quote = src("src/app/actions/quoteEmail.ts");
  assert.match(quote, /sender_title: sender\?\.jobTitle \?\? "",\s*sender_mobile: sender\?\.mobile \?\? "",\s*sender_email: user\.email,/);
});

test("signature lines can be switched off", () => {
  const html = render("quote", frameWith({ signature: { showJobTitle: false, showCompany: false, showPhone: false, showWebsite: false } }), PAT).html;
  const signature = html.slice(html.indexOf(">Pat Smith<"), html.indexOf("border-top:1px solid #eef0f3"));
  assert.match(signature, /pat@acme\.example/);
  assert.doesNotMatch(signature, /SALES MANAGER|ACME CARTS|082 555 0101|>acme\.example<\/a>/);
  const none = render("quote", frameWith({ signature: { showEmail: false } }), PAT).html;
  assert.doesNotMatch(none.slice(none.indexOf(">Pat Smith<"), none.indexOf("border-top:1px solid #eef0f3")), /mailto:/, "no empty email row");
});

test("the plain-text part shows exactly the signature the HTML shows — a hidden line is hidden in both", () => {
  // Review of #807: the text/plain signature ignored the switches, so a plain-text
  // mail app showed the mobile, email, title, company or website the owner had hidden.
  const signatureOf = (text: string) => (text.includes("\n\n--\n") ? text.slice(text.lastIndexOf("\n\n--\n") + 5) : null);
  const text = (signature: Partial<Block<"emailSignature">>) => render("quote", frameWith({ signature }), PAT).text;
  const ALL = "Pat Smith\nSales Manager\nAcme Carts\n082 555 0101 · pat@acme.example · acme.example";
  assert.equal(signatureOf(text({})), ALL);
  const switches: [Partial<Block<"emailSignature">>, string, string][] = [
    [{ showJobTitle: false }, "Sales Manager", "Pat Smith\nAcme Carts\n082 555 0101 · pat@acme.example · acme.example"],
    [{ showCompany: false }, "Acme Carts", "Pat Smith\nSales Manager\n082 555 0101 · pat@acme.example · acme.example"],
    [{ showPhone: false }, "082 555 0101", "Pat Smith\nSales Manager\nAcme Carts\npat@acme.example · acme.example"],
    [{ showEmail: false }, "pat@acme.example", "Pat Smith\nSales Manager\nAcme Carts\n082 555 0101 · acme.example"],
    [{ showWebsite: false }, " · acme.example", "Pat Smith\nSales Manager\nAcme Carts\n082 555 0101 · pat@acme.example"],
  ];
  for (const [off, hidden, expected] of switches) {
    const signature = signatureOf(text(off));
    assert.equal(signature, expected, JSON.stringify(off));
    assert.ok(!signature!.includes(hidden), `${JSON.stringify(off)} still shows ${hidden}`);
  }
  // Everything off: the name alone. No fallback to the company's number or address either.
  const bare = text({ showJobTitle: false, showCompany: false, showPhone: false, showEmail: false, showWebsite: false });
  assert.equal(signatureOf(bare), "Pat Smith");
  assert.doesNotMatch(bare, /082 555 0101|021 000 0000|pat@acme\.example|hi@acme\.example|Sales Manager/);

  // The signature hidden, or removed from the frame: no signature in either part.
  const hidden = render("quote", frameWith({ signature: { hidden: true } }), PAT);
  assert.equal(signatureOf(hidden.text), null);
  assert.doesNotMatch(hidden.text, /Pat Smith|082 555 0101|pat@acme\.example|Sales Manager/);
  assert.doesNotMatch(hidden.html, />Pat Smith<|082 555 0101|pat@acme\.example|SALES MANAGER/);
  const frame = defaultEmailFrame();
  const removed = documentSchema.parse({ ...frame, pages: [{ ...frame.pages[0], rows: frame.pages[0].rows.filter((r) => r.columns[0].blocks[0].type !== "emailSignature") }] });
  const without = renderEmailDocument({ frame: removed, body: defaultEmailBody("quote"), fields: fieldsFor("quote", PAT), brand, action: null });
  assert.equal(signatureOf(without.text), null);
  assert.doesNotMatch(without.text, /Pat Smith|082 555 0101|pat@acme\.example/);

  // An automatic message: the company's details, under the same switches.
  const auto = (signature: Partial<Block<"emailSignature">>) =>
    signatureOf(render("service_reminder", frameWith({ signature }), { first_name: "Jo", model: "Rover XL" }).text);
  assert.equal(auto({}), "Acme Carts\n021 000 0000 · hi@acme.example · acme.example");
  assert.equal(auto({ showPhone: false, showEmail: false }), "Acme Carts\nacme.example");

  // Both parts read the one function, so they cannot drift again.
  const source = src("src/lib/doceditor/emailRender.ts");
  assert.equal((source.match(/signatureLines\(block, ctx\)/g) ?? []).length, 2, "the HTML signature and the text signature");
  assert.equal((source.match(/senderOf\(ctx\)/g) ?? []).length, 1, "the sender's details are read only inside it");
});

test("the header can be styled: logo panel, a full-width colour bar, or the logo alone; size and position", () => {
  const panel = render("invite", defaultEmailFrame(), {}).html;
  assert.match(panel, /slant\.png/);
  const bar = render("invite", frameWith({ header: { style: "bar", background: "#123456", logoWidth: 300, align: "center" } }), {}).html;
  assert.match(bar, /<td align="center" class="pad" bgcolor="#123456" style="background-color:#123456;padding:24px 40px;"><img src="https:\/\/acme\.example\/logo\.png" alt="Acme Carts" width="300"/);
  assert.doesNotMatch(bar, /slant\.png/);
  const plain = render("invite", frameWith({ header: { style: "plain", logoWidth: 9999 } }), {}).html;
  assert.match(plain, /<td align="left" class="pad" style="padding:30px 40px 0;"><img [^>]*width="520"/, "size is capped to the card");
  // No logo: the company's name, readable on whatever colour the bar is.
  const light = renderEmailDocument({ frame: frameWith({ header: { style: "bar", background: "#ffee88" } }), body: defaultEmailBody("invite"), fields: {}, brand: { ...brand, logoUrl: "" }, action: null }).html;
  assert.match(light, /color:#0b1220;">ACME CARTS</);
  const dark = renderEmailDocument({ frame: frameWith({ header: { style: "bar", background: "#111111" } }), body: defaultEmailBody("invite"), fields: {}, brand: { ...brand, logoUrl: "" }, action: null }).html;
  assert.match(dark, /color:#ffffff;">ACME CARTS</);
});

test("the footer can be styled: its lines, alignment and colours", () => {
  const html = render("invite", frameWith({ footer: { note: "Thank you for your business.", showContact: false, align: "left", color: "#112233", background: "#f0f0f0" } }), {}).html;
  const footer = html.slice(html.indexOf("border-top:1px solid #eef0f3"));
  assert.match(html, /<td class="pad" align="left" bgcolor="#f0f0f0" style="border-top:1px solid #eef0f3;background-color:#f0f0f0;[^"]*text-align:left;color:#112233;">Thank you for your business\.<br \/>Acme Carts · 1 Main Rd, Cape Town</);
  assert.doesNotMatch(footer, /021 000 0000/, "contact line switched off");
  // Nothing to say → no footer row at all (not an empty band with a rule above it).
  const empty = render("invite", frameWith({ footer: { showCompany: false, showContact: false } }), {}).html;
  assert.doesNotMatch(empty, /border-top:1px solid #eef0f3/);
});

test("the frame's colours reach every email: page, card, buttons and accent", () => {
  const html = render("invite", frameWith({ email: { subject: "", pageColor: "#101010", cardColor: "#fafafa", buttonColor: "#224466", accentColor: "#00aa55" } }), { signing_link: "https://crm.acme.example/signing/tok" }).html;
  assert.match(html, /<body style="margin:0;padding:0;background-color:#101010;">/);
  assert.match(html, /class="card"[^>]*bgcolor="#fafafa"/);
  assert.match(html, /fillcolor="#224466"/, "Outlook's button too");
  assert.match(html, /<td bgcolor="#224466"/);
  assert.match(html, /<span style="color:#00aa55;">&rarr;<\/span>/);
  // Unset = the standard look and the workspace's brand colour; an unsafe value is dropped, never written into a style.
  const standard = render("invite", defaultEmailFrame(), { signing_link: "https://crm.acme.example/signing/tok" }).html;
  assert.match(standard, /background-color:#f3f4f6;/);
  assert.match(standard, /fillcolor="#0b0f19"/);
  const unsafe = frameWith({ email: { subject: "", pageColor: `red;background:url(https://evil.example/x)` } });
  assert.equal(unsafe.email?.pageColor, "");
});

test("a frame saved before styling existed still parses, and renders exactly as the standard frame", () => {
  const old = JSON.parse(JSON.stringify(defaultEmailFrame())) as { pages: { rows: { columns: { blocks: Record<string, unknown>[] }[] }[] }[] };
  for (const row of old.pages[0].rows) {
    const block = row.columns[0].blocks[0];
    for (const key of Object.keys(block)) if (!["id", "type", "settings", "locked", "hidden", "note"].includes(key)) delete block[key];
  }
  const parsed = documentSchema.parse(old);
  const input = { body: defaultEmailBody("quote"), fields: fieldsFor("quote", PAT), brand, action: null };
  assert.equal(renderEmailDocument({ ...input, frame: parsed }).html, renderEmailDocument({ ...input, frame: defaultEmailFrame() }).html);
});

test("a message is edited inside its frame: the header above it, the signature and footer below, in the frame's colours", () => {
  const frame = frameWith({ header: { style: "bar", background: "#123456" }, email: { subject: "", cardColor: "#fafafa" } });
  const around = emailFramePreview(frame, PAT, brand);
  assert.match(around.top, /bgcolor="#123456"/);
  assert.doesNotMatch(around.top, /Pat Smith/);
  assert.match(around.bottom, />Pat Smith</);
  assert.match(around.bottom, /1 Main Rd, Cape Town/);
  assert.equal(around.card, "#fafafa");
  // The canvas draws exactly what is sent: the same rows, in the same order.
  const sent = renderEmailDocument({ frame, body: defaultEmailBody("quote"), fields: PAT, brand, action: null }).html;
  const rows = (html: string) => html.replace(/^<table[^>]*>/, "").replace(/<\/table>$/, "");
  assert.ok(sent.includes(rows(around.top)) && sent.includes(rows(around.bottom)));
  assert.ok(sent.indexOf(rows(around.top)) < sent.indexOf(rows(around.bottom)));
  // A message's own button takes the frame's colour on the canvas too.
  const button = defaultEmailBody("invite").pages[0].rows.flatMap((r) => r.columns[0].blocks).find((b) => b.type === "emailButton")!;
  assert.match(emailBlockPreviewHtml(button, { signing_link: "https://x.example/s" }, brand, frameWith({ email: { subject: "", buttonColor: "#224466" } })), /bgcolor="#224466"/);

  const page = src("src/app/doc-editor/[id]/page.tsx");
  assert.match(page, /where: \{ tenantId, key: EMAIL_FRAME_KEY, deletedAt: null \}/, "this workspace's frame, named in the query");
  const canvas = src("src/components/doceditor/Canvas.tsx");
  assert.match(canvas, /\{email\?\.message && <FramePart html=\{email\.top\}/);
  assert.match(canvas, /\{email\?\.message && <FramePart html=\{email\.bottom\}/);
  assert.match(canvas, /Shared frame · Edit/);
});

test("the frame's parts have real controls in the editor, and an email can be reset to the standard", () => {
  const panel = src("src/components/doceditor/PropertiesPanel.tsx");
  assert.match(panel, /\{block\.type === "emailHeader" && <EmailHeaderProps block=\{block\} \/>\}/);
  assert.match(panel, /\{block\.type === "emailSignature" && <EmailSignatureProps block=\{block\} \/>\}/);
  for (const key of ["pageColor", "cardColor", "buttonColor", "accentColor"]) assert.ok(panel.includes(`["${key}", `), key);
  // Typing a subject must not wipe the document's other email settings.
  assert.match(src("src/components/doceditor/DocEditor.tsx"), /email: \{ \.\.\.d\.email, subject \}/);
  const reset = src("src/app/actions/docbuilder.ts");
  assert.match(reset, /const standard = emailKind\s*\? defaultEmailBody\(emailKind\)\s*: isEmail\s*\? defaultEmailFrame\(\)/);
  assert.match(reset, /if \(!\(await canEditLayout\(user, tpl\.key\)\)\)/, "owner-only for an email, as editing is");
});

test("customer emails are not listed as builder layouts", () => {
  assert.match(src("src/lib/docbuilder/store.ts"), /where: \{ NOT: \{ key: \{ startsWith: "email:" \} \} \},\s*orderBy: \[\{ key: "asc" \}, \{ updatedAt: "desc" \}\],/);
});

test("declining is offered beside signing — in the bar that follows the page, and by the sign button — and staff see the reason", () => {
  const surface = src("src/app/signing/[token]/SignSurface.tsx");
  assert.equal((surface.match(/\{declineDialog\(<button/g) ?? []).length, 2);
  const bar = surface.slice(surface.indexOf("Sticky progress bar"));
  assert.ok(bar.indexOf("Go to sign →") < bar.indexOf("{declineDialog(") && bar.indexOf("{declineDialog(") < bar.indexOf("{signingId && ("), "Decline sits in the sticky bar");
  assert.match(surface, /onSubmit=\{decline\}/);
  assert.match(src("src/lib/signing/record.ts"), /declinedAt: r\.declinedAt, declineReason: r\.declineReason,/);
  assert.match(src("src/components/SigningBlock.tsx"), /Their reason: “\$\{declined\.declineReason\.trim\(\)\}”/);
  // And the messages that ask for a signature say so.
  for (const kind of ["invite", "reminder", "invite_whatsapp", "reminder_whatsapp"] as const) {
    assert.match(SIGNING_EMAILS[kind].body, /[Dd]ecline/, kind);
  }
});

/** A document as Postgres jsonb hands it back: same content, keys in another order. */
function asStored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asStored);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, asStored(v)]));
}

test("a draft is 'untouched' only when it is EXACTLY what was seeded — any edit, however early, keeps it", () => {
  // Review of #807: "untouched" was `updatedAt - createdAt < 5s`, but the editor
  // autosaves ~1.2s after a keystroke, so a first edit made straight after the
  // email was created looked untouched and was overwritten on the next load.
  for (const kind of EMAIL_KINDS) {
    const old = STANDARD_WORDING_2026_10_07[kind];
    assert.ok(old, `${kind}: the replaced wording is on record`);
    const seeded = asStored(JSON.parse(JSON.stringify(defaultEmailBody(kind, null, old))));
    assert.equal(isUntouchedEmailSeed(kind, seeded), true, `${kind}: exactly as seeded`);
    // The current standard is not a replaced seed, so a refreshed draft is never refreshed again.
    assert.equal(isUntouchedEmailSeed(kind, defaultEmailBody(kind)), false, `${kind}: already current`);
  }

  // One character typed, seconds after creation — no timestamp is consulted, so it can never be lost.
  const edited = JSON.parse(JSON.stringify(defaultEmailBody("invite", null, STANDARD_WORDING_2026_10_07.invite))) as DocumentModel;
  const firstText = edited.pages[0].rows.flatMap((r) => r.columns[0].blocks).find((b) => b.type === "text") as Block<"text">;
  (firstText.value[0] as { children: { text?: string }[] }).children[0].text = "Hi there ";
  assert.equal(isUntouchedEmailSeed("invite", edited), false, "a changed word");
  // The other ways an owner can change an email without touching its words.
  const seed = () => JSON.parse(JSON.stringify(defaultEmailBody("quote", null, STANDARD_WORDING_2026_10_07.quote))) as DocumentModel;
  const subject = seed();
  subject.email = { subject: "Our quote for you" };
  assert.equal(isUntouchedEmailSeed("quote", subject), false, "a changed subject");
  const removed = seed();
  removed.pages[0].rows.pop();
  assert.equal(isUntouchedEmailSeed("quote", removed), false, "a removed block");
  const restyled = seed();
  const button = defaultEmailBody("invite").pages[0].rows[0];
  restyled.pages[0].rows.push(button);
  assert.equal(isUntouchedEmailSeed("quote", restyled), false, "an added block");
  const hidden = seed();
  hidden.pages[0].rows[0].columns[0].blocks[0].hidden = true;
  assert.equal(isUntouchedEmailSeed("quote", hidden), false, "a hidden block");

  // A workspace that had written its own wording was seeded from THAT; the same rule applies to it.
  const own = { subject: "Your Acme quote", body: "Hello {{first_name}},\n\nQuote attached.\n\nRegards,\n{{company_name}}" };
  const ownSeed = asStored(JSON.parse(JSON.stringify(defaultEmailBody("quote", own, STANDARD_WORDING_2026_10_07.quote))));
  assert.equal(isUntouchedEmailSeed("quote", ownSeed, own), true);
  assert.equal(isUntouchedEmailSeed("quote", ownSeed), false, "not mistaken for the standard seed");
  // Unreadable or foreign data is never "untouched".
  assert.equal(isUntouchedEmailSeed("quote", null), false);
  assert.equal(isUntouchedEmailSeed("quote", { junk: true }), false);
  assert.equal(isUntouchedEmailSeed("invite", ownSeed), false, "another email's seed");
});


test("real pre-upgrade draft labels from #806 and #807 are recognised across all 13 emails", () => {
  // Reconstruct the old seed structure, then stamp the ACTUAL old labels
  // independently of the current factory. Previously the test rebuilt old
  // drafts using new CTA defaults, hiding a 7-of-13 recognition failure.
  const oldButtons: Partial<Record<SigningEmailKind, string>> = {
    invite: "Open & sign",
    reminder: "Open & sign",
    review_delivery: "Leave a review",
    review_service: "Leave a review",
    survey_invite: "Answer the survey",
    survey_reminder: "Answer the survey",
  };
  for (const revision of [STANDARD_WORDING_2026_10_07, STANDARD_WORDING_2026_10_08]) {
    for (const kind of EMAIL_KINDS) {
      const wording = revision[kind]!;
      assert.ok(wording, `missing archived ${kind}`);
      // Deliberately discard the archived design metadata to reproduce the
      // old stored body, then restore each old literal by hand below.
      const oldDraft = defaultEmailBody(kind, null, {
        subject: wording.subject,
        body: wording.body,
        headline: wording.headline,
      });
      const all = oldDraft.pages.flatMap((p) => p.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)));
      const button = all.find((b) => b.type === "emailButton");
      if (button?.type === "emailButton") button.label = oldButtons[kind] ?? button.label;
      const facts = all.find((b) => b.type === "emailFacts");
      if (facts?.type === "emailFacts") facts.items[0].label = "QUOTE";
      assert.equal(
        isUntouchedEmailSeed(kind, asStored(oldDraft)),
        true,
        `${kind} from ${revision === STANDARD_WORDING_2026_10_07 ? "#806" : "#807"} must upgrade`,
      );
      // A manual change to any visible label is not considered an untouched seed.
      if (button?.type === "emailButton") {
        button.label = "Custom button";
        assert.equal(isUntouchedEmailSeed(kind, oldDraft), false, `${kind} custom CTA is preserved`);
      }
    }
  }
});

test("the refresh reads content, never timestamps; only unpublished drafts; and only if unchanged since read", () => {
  const seed = src("src/lib/doceditor/emailSeeding.ts");
  assert.doesNotMatch(seed, /createdAt|getTime\(\)|UNTOUCHED_MS/, "no timestamp decides whether a draft was edited");
  assert.match(seed, /where: \{ tenantId, key: \{ in: EMAIL_KINDS\.map\(emailBodyKey\) \}, deletedAt: null, publishedVersion: null \},/);
  assert.match(seed, /if \(!kind \|\| !isUntouchedEmailSeed\(kind, row\.data, storedFor\(kind\)\)\) continue;/);
  // The write is conditional on the row being exactly as read — a save or a publish in between wins.
  assert.match(seed, /where: \{ id: row\.id, tenantId, updatedAt: row\.updatedAt, publishedVersion: null \},/);
  assert.doesNotMatch(seed, /publishedVersion: \d|status: "published"/, "still a draft — nothing changes for customers");
});

test("the standard wording is professional: a formal greeting, no emoji, no chatty contractions", () => {
  for (const def of Object.values(SIGNING_EMAILS)) {
    if (def.channel) continue;
    const words = `${def.subject}\n${def.body}`;
    assert.doesNotMatch(words, /\p{Extended_Pictographic}/u, def.kind);
    assert.doesNotMatch(words, /\bHi\b|we'd|we'll|didn't|you're|just (reply|call)|mean the world|100%/i, def.kind);
    assert.match(def.body, /Kind regards,\n(\{\{sender_name\}\}\n)?\{\{company_name\}\}$/, def.kind);
  }
});
