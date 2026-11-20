import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanDetail, extrasHtml, mayEdit, parseLocked, parseTeamLines, photoHtml, shortSignature, teamLineFor, whatsappLink,
} from "../src/lib/signaturePeople";
import { buildSignature, DEFAULT_SIGNATURE_DESIGN, parseSignatureDesign, type SignatureCompany } from "../src/lib/signature";

// The Email signatures pack, items 1–4 (Sean, 2026-11-20): each person's extra details, which details staff may change,
// a line per team, and a short signature on replies.

const src = (f: string) => readFileSync(f, "utf8");

const company: SignatureCompany = {
  name: "Denago Cape Town", logoUrl: "", website: "", switchboard: "021 000 0000", address: "", tagline: "",
  facebook: "", instagram: "", assetBase: "https://crm.example.com", design: DEFAULT_SIGNATURE_DESIGN,
};
const person = { name: "Ann Smith", email: "ann@example.com", mobile: "082 111 2222", jobTitle: "Sales", signatureHtml: null };

test("details are checked the same way on the form and the server", () => {
  assert.deepEqual(cleanDetail("directLine", "  021 555 1234 "), { ok: true, value: "021 555 1234" });
  assert.equal(cleanDetail("whatsapp", "call me").ok, false);
  assert.deepEqual(cleanDetail("hours", ""), { ok: true, value: null }, "empty clears it");
  assert.equal(cleanDetail("bookingUrl", "javascript:alert(1)").ok, false, "only https links");
  assert.equal(cleanDetail("bookingUrl", "http://cal.example.com").ok, false);
  assert.equal(cleanDetail("bookingUrl", "https://cal.example.com/ann").ok, true);
  assert.equal(cleanDetail("qualifications", "x".repeat(121)).ok, false);
});

test("locks: staff can't change a locked detail; the owner can change any", () => {
  assert.deepEqual(parseLocked(["photo", "nonsense", "hours"]), ["hours", "photo"]);
  assert.deepEqual(parseLocked("photo"), []);
  assert.equal(mayEdit("hours", ["hours"], false), false);
  assert.equal(mayEdit("hours", ["hours"], true), true);
  assert.equal(mayEdit("whatsapp", ["hours"], false), true);
});

test("team lines: one per team, short, no line breaks; someone in two teams gets the first", () => {
  const lines = parseTeamLines([
    { teamId: "team_aaaaaa", line: "Workshop\n8–5" },
    { teamId: "team_aaaaaa", line: "duplicate" },
    { teamId: "bad id!", line: "dropped" },
    { teamId: "team_bbbbbb", line: "" },
    { teamId: "team_cccccc", line: "y".repeat(400) },
  ]);
  assert.deepEqual(lines.map((l) => l.teamId), ["team_aaaaaa", "team_cccccc"]);
  assert.equal(lines[0].line, "Workshop 8–5");
  assert.equal(lines[1].line.length, 160);
  assert.equal(teamLineFor(lines, ["team_cccccc", "team_aaaaaa"]), "Workshop 8–5");
  assert.equal(teamLineFor(lines, ["team_zzzzzz"]), "");
});

test("the extras show only what is set, escaped", () => {
  assert.equal(extrasHtml({}, "", "#f00"), "", "nothing set: nothing added");
  const html = extrasHtml({ directLine: "021 555 1234", whatsapp: "082 555 1234", bookingUrl: "https://cal.example.com/a?x=1&y=2", hours: "Mon–Fri <8–5>" }, "Parts 021 1", "#f00");
  assert.match(html, /href="tel:0215551234"/);
  assert.match(html, /href="https:\/\/wa\.me\/27825551234"/, "0… becomes 27…");
  assert.match(html, /href="https:\/\/cal\.example\.com\/a\?x=1&amp;y=2"/);
  assert.match(html, /Mon–Fri &lt;8–5&gt;/);
  assert.match(html, /Parts 021 1/);
  assert.equal(whatsappLink("123"), "");
  assert.equal(photoHtml({ photoUrl: null }, "Ann"), "");
  assert.match(photoHtml({ photoUrl: "https://crm.example.com/api/signature-photo/user_123456" }, "Ann"), /<img src="https:\/\/crm\.example\.com\/api\/signature-photo\/user_123456"/);
});

test("the signature carries the details on both designs; without them it is exactly the automatic one", () => {
  const extras = { qualifications: "CA(SA)", hours: "Mon–Fri 8–5", photoUrl: "https://crm.example.com/api/signature-photo/user_123456" };
  for (const style of ["card", "classic"] as const) {
    const design = { ...DEFAULT_SIGNATURE_DESIGN, style };
    const plain = buildSignature(person, { ...company, design });
    const withDetails = buildSignature({ ...person, extras, teamLine: "Workshop line" }, { ...company, design });
    assert.equal(buildSignature({ ...person, extras: {}, teamLine: "" }, { ...company, design }), plain, `${style}: empty details change nothing`);
    for (const bit of ["CA(SA)", "Mon–Fri 8–5", "Workshop line", "/api/signature-photo/user_123456"]) assert.ok(withDetails.includes(bit), `${style}: ${bit}`);
  }
});

test("short replies: two plain lines on a reply, only when the owner switched it on; new emails keep the full one", () => {
  const on = { ...company, design: { ...DEFAULT_SIGNATURE_DESIGN, shortReplies: true } };
  const off = { ...company, design: { ...DEFAULT_SIGNATURE_DESIGN, shortReplies: false } };
  const short = buildSignature({ ...person, reply: true }, on);
  assert.equal(short.replace(/#[0-9a-f]{6}/gi, ""), shortSignature(person, on, "").replace(/#[0-9a-f]{6}/gi, ""), "the short signature, in the design's accent");
  assert.doesNotMatch(short, /<img/);
  assert.match(short, /Ann Smith · Sales · Denago Cape Town/);
  assert.notEqual(buildSignature({ ...person, reply: false }, on), short, "a new email keeps the full signature");
  assert.notEqual(buildSignature({ ...person, reply: true }, off), short, "off: replies keep the full signature");
  assert.match(buildSignature({ ...person, reply: true, signatureHtml: "<b>mine</b>" }, on), /<b>mine<\/b>/, "own HTML still wins");
});

test("the rules are stored on the design and survive a design save", () => {
  const parsed = parseSignatureDesign(JSON.stringify({ style: "card", locked: ["photo", "bad"], teams: [{ teamId: "team_aaaaaa", line: "x" }], shortReplies: true }));
  assert.deepEqual(parsed.locked, ["photo"]);
  assert.deepEqual(parsed.teams, [{ teamId: "team_aaaaaa", line: "x" }]);
  assert.equal(parsed.shortReplies, true);
  assert.equal(parseSignatureDesign(null).shortReplies, false);
  const save = src("src/app/actions/emails.ts");
  assert.match(save, /\.\.\.\(await storedSignatureDesign\(tenantId\)\),/, "saving the design keeps the rules");
});

test("server: the pack gates every write; locks are checked on the server; writes name the workspace", () => {
  const actions = src("src/app/actions/emailSignatures.ts");
  assert.equal(actions.match(/if \(!\(await isModuleEnabled\("signatures"\)\)\) refuse\(/g)?.length, (actions.match(/^export async function/gm) ?? []).length, "every action");
  assert.match(actions, /detailsFrom\(formData, design\.locked \?\? \[\], owner\)/, "a person's own save respects the locks");
  assert.match(actions, /export async function saveStaffSignatureDetails[\s\S]*?requireTenantOwner\(\)[\s\S]*?tenantMember\.findFirst\(\{ where: \{ tenantId, userId \}/, "owner only, and only someone in this workspace");
  assert.match(actions, /export async function saveSignatureRules[\s\S]*?requireTenantOwner\(\)[\s\S]*?listActingTenantTeams\(\)/, "owner only; only this workspace's teams");
  assert.match(actions, /appSetting\.upsert\(\{\s*where: \{ tenantId_key: \{ tenantId, key: SIGNATURE_DESIGN_KEY \} \}/);
  // Only the owner may set a custom HTML signature (it replaces the whole branded one); anyone can clear theirs.
  assert.match(src("src/app/actions/settings.ts"), /signatureHtml[\s\S]{0,400}isTenantOwner\(\)/);
});

test("the sender's details: read only while the pack is on, only for a member of the workspace; the photo is embedded", () => {
  const sender = src("src/lib/signatureSender.ts");
  assert.match(sender, /if \(!tenantId \|\| !\(await isModuleEnabled\("signatures"\)\)\) return \{\};/);
  assert.equal(sender.match(/memberships: \{ some: \{ tenantId \} \}/g)?.length, 2);
  assert.match(src("src/lib/emailInlineLogo.ts"), /if \(photoOf\) return \(await import\("\.\/signatureSender"\)\)\.signaturePhotoBytes\(tenantId, photoOf\);/);
  // Every send path builds the signature with the sender's details.
  for (const f of ["src/lib/composerSend.ts", "src/app/actions/quoteEmail.ts"]) assert.match(src(f), /senderSignatureDetails\(/, f);
  assert.match(src("src/lib/composerSend.ts"), /reply: Boolean\(answering\)/, "replies are told they are replies");
});

test("the page: everyone edits their own signature; the owner also gets the design, the rules and the team", () => {
  const page = src("src/app/(app)/email-signatures/page.tsx");
  assert.match(page, /isOwner \? listActingTenantTeams\(\) : Promise\.resolve\(\[\]\)/);
  assert.match(page, /isOwner \? listActingTenantStaff\(\) : Promise\.resolve\(\[\]\)/);
  assert.match(page, /memberships: \{ some: \{ tenantId \} \}/, "only people in this workspace");
  assert.match(page, /teamMember\.findMany\(\{\s*where: \{ tenantId,/, "team lines from this workspace's teams");
  assert.match(page, /\{\(isOwner \|\| Boolean\(me\.signatureHtml\?\.trim\(\)\)\) && \(/, "the design is the owner's; staff see it only to clear old HTML");
  assert.match(page, /designPreview=\{isOwner\}/);
  const ui = src("src/components/EmailSignatureDetails.tsx");
  assert.match(ui, /Your signature[\s\S]*?editor\(me, saveMySignatureDetails, "Save my signature", isOwner(, sendMySignatureTest)?\)/);
  assert.match(ui, /\{isOwner && \(\s*<section[\s\S]*?Rules for everyone/);
  assert.match(ui, /\{isOwner && staff\.length > 0 && \(/);
  assert.match(ui, /saveStaffSignatureDetails\.bind\(null, person\.id\)/);
});

test("the visual editor: the preview is the send path's own signature, redrawn from what is typed; locked details aren't sent", () => {
  const editor = src("src/components/SignatureVisualEditor.tsx");
  assert.match(editor, /^"use client";/);
  assert.match(editor, /buildEmailHtml\("", buildSignature\(\{ \.\.\.person, signatureHtml: null, extras, teamLine \}, company\)\)/);
  assert.match(editor, /onChange=\{\(e\) => setValues/, "redrawn as you type");
  assert.match(editor, /problem\(field\) \? "" : values\[field\]\.trim\(\)/, "a detail that won't save isn't previewed");
  assert.match(editor, /<input value=\{values\[field\] \|\| "—"\} readOnly disabled/, "a locked detail has no name, so it is not sent");
  assert.match(editor, /photoUrl: photo && initial\.hasPhoto \? `\/api\/signature-photo\/\$\{person\.id\}` : null/);
  assert.match(editor, /sandbox="allow-same-origin"/);
});

test("the preview photo: the person and the owner see it before it is switched on; a sent email only when on", () => {
  const route = src("src/app/api/signature-photo/[userId]/route.ts");
  assert.match(route, /userId === viewerId \|\|\s*\(await basePrisma\.tenant\.findFirst\(\{ where: \{ id: tenantId, ownerUserId: viewerId \}/);
  const sender = src("src/lib/signatureSender.ts");
  assert.match(sender, /\.\.\.\(evenIfOff \? \{\} : \{ signaturePhoto: true \}\)/);
  assert.doesNotMatch(src("src/lib/emailInlineLogo.ts"), /evenIfOff/, "emails never use the preview's exception");
});
