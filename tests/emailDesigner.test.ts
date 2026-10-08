import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderEmailDocument, withEditedText, type EmailBrand } from "../src/lib/doceditor/emailRender";
import { defaultEmailBody, defaultEmailFrame, EMAIL_HEADLINES, EMAIL_KINDS, emailKindOf } from "../src/lib/doceditor/emailDefaults";
import { documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";
import { SIGNING_EMAILS, type SigningEmailKind } from "../src/lib/signing/emailTemplates";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const brand: EmailBrand = {
  companyName: "Acme Carts", tagline: "Dealer", address: "1 Main Rd, Cape Town", phone: "021 000 0000", email: "hi@acme.example",
  website: "acme.example", logoUrl: "https://acme.example/logo.png", bannerUrl: "", accent: "#f1603c", assetBase: "https://crm.acme.example",
};
const SAMPLE: Record<string, string> = {
  recipient_name: "Jane Doe", first_name: "Jane", document_title: "Quote Q-42", quote_number: "Q-42", company_name: "Acme Carts",
  sender_name: "Pat Smith", company_phone: "021 000 0000", company_email: "hi@acme.example", signing_link: "https://crm.acme.example/signing/tok",
  code: "482913", total: "R 1 000,00", review_link: "https://g.page/r/x", survey_link: "https://crm.acme.example/s/tok",
};
const fieldsFor = (kind: SigningEmailKind, over: Record<string, string> = {}) =>
  Object.fromEntries(SIGNING_EMAILS[kind].fields.map((f) => [f, over[f] ?? SAMPLE[f] ?? ""]));
const render = (kind: SigningEmailKind, body?: DocumentModel, over: Record<string, string> = {}, b: Partial<EmailBrand> = {}) =>
  renderEmailDocument({ frame: defaultEmailFrame(), body: body ?? defaultEmailBody(kind), fields: fieldsFor(kind, over), brand: { ...brand, ...b }, action: SIGNING_EMAILS[kind].action ?? null });
const blocks = (doc: DocumentModel) => doc.pages.flatMap((p) => p.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)));

test("every email has a default design: valid, its subject, its action, and a headline from its own fields only", () => {
  assert.equal(EMAIL_KINDS.length, 13);
  for (const kind of EMAIL_KINDS) {
    const def = SIGNING_EMAILS[kind];
    const body = defaultEmailBody(kind);
    assert.ok(documentSchema.safeParse(body).success, kind);
    assert.equal(body.email?.subject, def.subject, kind);
    // As a button/code block, or — where the wording names it mid-sentence ("Your login code is {{code}}") — inline.
    if (def.action) {
      assert.ok(
        blocks(body).some((b) => (b.type === "emailButton" && b.token === def.action) || (b.type === "text" && JSON.stringify(b.value).includes(`"token":"${def.action}"`))),
        `${kind}: its ${def.action}`,
      );
    }
    for (const [, token] of (EMAIL_HEADLINES[kind] ?? "").matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok((def.fields as readonly string[]).includes(token), `${kind}: headline uses {{${token}}}, which it doesn't have`);
    }
    assert.equal(emailKindOf(`email:${kind}`), kind);
  }
  assert.equal(emailKindOf("email:invite_whatsapp"), null, "texts and WhatsApp stay text");
  assert.equal(emailKindOf("quote"), null);
});

test("design B: the frame wraps the body — logo panel, message, the sender as signature, a quiet footer", () => {
  const { html, subject } = render("invite");
  assert.equal(subject, "Please sign your document: Quote Q-42");
  assert.ok(html.indexOf('src="https://acme.example/logo.png"') < html.indexOf("Please sign Quote Q-42"), "header above the message");
  assert.ok(html.indexOf("Please sign Quote Q-42") < html.indexOf(">Pat Smith<"), "the message above the signature");
  assert.match(html, /href="https:\/\/crm\.acme\.example\/signing\/tok"[^>]*>Open &amp; sign/);
  assert.match(html, /1 Main Rd, Cape Town/);
  assert.match(html, /@media \(max-width: 600px\)/);
  // The banner wins over the logo when there is one; with neither, the company name.
  assert.match(render("invite", undefined, {}, { bannerUrl: "https://blob.example/b.png" }).html, /<img class="sig-banner" src="https:\/\/blob\.example\/b\.png"/);
  assert.match(render("invite", undefined, {}, { logoUrl: "", bannerUrl: "" }).html, />ACME CARTS</);
});

test("the old sign-off's name lines go (the signature says who it's from); the quote shows its number and total", () => {
  const quote = render("quote");
  assert.equal((quote.html.match(/>Pat Smith</g) ?? []).length, 1, "the sender once, in the signature");
  assert.match(quote.html, /TOTAL INCL\. VAT[\s\S]*R 1 000,00/);
  assert.match(quote.text, /QUOTE: Q-42\nTOTAL INCL\. VAT: R 1 000,00/);
  assert.match(quote.text, /--\nPat Smith\nAcme Carts/);
});

test("customer data is escaped; a field the message lacks renders as nothing; a link must be http(s)", () => {
  const evil = render("invite", undefined, { recipient_name: `<img src=x onerror=alert(1)>` });
  assert.doesNotMatch(evil.html, /<img src=x/);
  assert.match(evil.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const body = defaultEmailBody("invite");
  const text = blocks(body).find((b) => b.type === "text") as Extract<DocumentBlock, { type: "text" }>;
  text.value = [{ type: "p", children: [{ text: "Email: " }, { type: "mergeField", token: "customer.email", children: [{ text: "" }] }, { text: "." }] }];
  assert.match(render("invite", body).html, />Email: \.</, "no placeholder pill, no other record's data");
  assert.match(render("invite", undefined, { signing_link: "javascript:alert(1)" }).html, /href="#"/);
});

test("never sent without its action; a code is shown large; a secret never reaches the subject", () => {
  const body = defaultEmailBody("invite");
  for (const page of body.pages) for (const row of page.rows) for (const col of row.columns) col.blocks = col.blocks.filter((b) => b.type !== "emailButton");
  body.email = { subject: "Sign {{document_title}} at {{signing_link}}" };
  const r = render("invite", body);
  assert.match(r.html, /href="https:\/\/crm\.acme\.example\/signing\/tok"/, "the button is put back");
  assert.equal(r.subject, "Sign Quote Q-42 at");
  assert.match(r.text, /Open and sign here:\nhttps:\/\/crm\.acme\.example\/signing\/tok/);
  assert.match(render("otp").html, /letter-spacing:8px;[^>]*>482913</);
});

test("an owner's edited wording carries over: formatting, lists and its own subject", () => {
  const body = defaultEmailBody("invite", {
    subject: "Sign it, {{first_name}}",
    body: "",
    doc: [
      { type: "p", children: [{ text: "Hi " }, { type: "mergeField", token: "first_name", children: [{ text: "" }] }, { text: "!", bold: true }] },
      { type: "p", listStyleType: "disc", children: [{ text: "one" }] },
      { type: "p", listStyleType: "disc", children: [{ text: "two" }] },
      { type: "p", children: [{ type: "mergeField", token: "signing_link", children: [{ text: "" }] }] },
    ],
  });
  const r = render("invite", body);
  assert.equal(r.subject, "Sign it, Jane");
  assert.match(r.html, /Hi Jane<strong>!<\/strong>/);
  assert.match(r.html, /<ul[^>]*><li[^>]*>one<\/li><li[^>]*>two<\/li><\/ul>/);
  assert.equal(blocks(body).filter((b) => b.type === "emailButton").length, 1);
});

test("a per-send edit swaps the paragraphs only: headline, figures and button stay", () => {
  const body = withEditedText(defaultEmailBody("quote"), "Hi Jane,\n\nHere is the revised quote.");
  const kinds = blocks(body).map((b) => b.type);
  assert.deepEqual(kinds, ["heading", "text", "emailFacts"], "one text block where the first was; the rest kept");
  const r = render("quote", body);
  assert.match(r.html, /Here is the revised quote\./);
  assert.doesNotMatch(r.html, /Thank you for your interest/);
  assert.equal(r.bodyText, "Hi Jane,\n\nHere is the revised quote.");
  // The quote dialog shows and compares exactly that text, not the whole email.
  const quoteAction = src("src/app/actions/quoteEmail.ts");
  assert.match(quoteAction, /body: email\.bodyText \?\? email\.text/);
  assert.match(quoteAction, /\(standard\.bodyText \?\? standard\.text\)\.replace/);
});

test("emails are designed in the document editor — owner-only, previewed without sending, created once", () => {
  assert.match(src("src/lib/docbuilder/layoutAccess.ts"), /if \(key\.startsWith\("email:"\)\) return isTenantOwner\(\);/);
  const preview = src("src/app/api/email-preview/[id]/route.ts");
  assert.match(preview, /if \(!\(await canEditLayout\(user, template\.key\)\)\) return new Response\("Not found", \{ status: 404 \}\);/);
  assert.doesNotMatch(preview, /sendEmail|nodemailer/, "a preview never sends");
  assert.doesNotMatch(preview, /<script/, "the site's CSP refuses inline scripts");
  const seed = src("src/lib/doceditor/emailSeeding.ts");
  assert.match(seed, /pg_advisory_xact_lock\(hashtext\(\$\{`email-templates:\$\{tenantId\}`\}\)\)/);
  assert.match(seed, /found = index\(await tx\.docBuilderTemplate\.findMany\(query\)\);/, "re-read under the lock");
  assert.doesNotMatch(seed, /publishedVersion: \d|status: "published"/, "created as drafts — nothing changes for customers");
  const page = src("src/app/doc-editor/[id]/page.tsx");
  assert.match(page, /if \(emailKind \|\| template\.key === EMAIL_FRAME_KEY\) \{/);
  const editor = src("src/components/doceditor/DocEditor.tsx");
  assert.match(editor, /\{!email && \(\s*<button type="button" className=\{buttonClass\} onClick=\{\(\) => addPage\(\)\}/, "an email has no pages");
  assert.match(editor, /\{!isDocument && !email && \(<>/, "no import/export for an email");
  assert.match(editor, /`\/api\/email-preview\/\$\{id\}`/);
});

test("the send path uses the design only once the frame is PUBLISHED, read by explicit tenant", () => {
  const send = src("src/lib/signing/signingEmail.ts");
  assert.match(send, /await publishedEmailDocs\(tenantId, kind\)/);
  assert.match(send, /if \(frame\) \{/);
  assert.match(send, /const design = body \?\? defaultEmailBody\(kind, parseStoredSigningTemplate\(setting\(def\.settingKey\), kind\)\);/);
  // A per-send edit (the quote dialog) changes the words, never the design.
  assert.match(send, /\? \{ \.\.\.withEditedText\(design, override\.body\), email: \{ subject: override\.subject \} \}/);
  assert.match(send, /brand: await emailBrandFor\(tenantId\)/, "the send's look is the editor's look");
  assert.match(send, /isTextTemplate\(def\) \? \{ frame: null, body: null \}/, "texts and WhatsApp never");
  const docs = src("src/lib/doceditor/emailDocuments.ts");
  assert.match(docs, /where: \{ tenantId, key: \{ in: \[EMAIL_FRAME_KEY, emailBodyKey\(kind\)\] \}, deletedAt: null, publishedVersion: \{ not: null \} \}/);
  assert.match(docs, /basePrisma\.docBuilderVersion\.findUnique/);
});
