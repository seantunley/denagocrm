import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  REPORT_MAX_COLUMNS,
  REPORT_RULE,
  REPORT_TITLE_CHARS,
  buildReport,
  isWrittenAsReport,
  printable,
  reportFileName,
  titleFromQuestion,
  wantsReport,
} from "../src/lib/assistantReport";
import { ANSWER_RULES, DATA_RULE, isComplexQuestion } from "../src/lib/crmAssistantPlan";
import { selfKnowledge } from "../src/lib/assistantSoul";

/**
 * The assistant's answers as PDF reports (lib/assistantReport.ts).
 *
 * What these hold: a report is the answer laid out and nothing more; only the
 * person who was answered can have it; the header carries the business's own
 * name and logo; and the logo is never fetched from an address nobody vouched for.
 */

const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const REPORT = [
  "Report: Stuck deals, week of 9 November",
  "Seven open deals have gone quiet. [[1]] ⚠️",
  "",
  "Waiting on the customer:",
  "- Anna — quote viewed, unsigned for 6 days [[/quotes/abc]]",
  "- Ben — asked about finance, no reply since",
  "",
  "Waiting on us:",
  "Columns: Customer | Value | Days quiet",
  "- Cara | R 84 000 | 9",
  "- Dan | R 126 500 | 7",
  "",
  "My read: The two waiting on us are the quickest wins. 📞",
  "Not in the CRM: Whether Ben was approved for finance.",
  "",
  "What to do next:",
  "1. Reply to Cara and Dan today.",
  "2. Call Anna.",
  "",
  "Press PDF under this answer to download it with the business's name and logo.",
].join("\n");

/* ── the layout ───────────────────────────────────────────────────── */

test("a report DAX wrote lays out as title, summary, sections, a table, its judgement and its gaps", () => {
  const report = buildReport("compile a report on my stuck deals", REPORT);
  assert.equal(report.title, "Stuck deals, week of 9 November");
  assert.deepEqual(report.blocks.map((b) => b.kind), ["paragraph", "heading", "list", "heading", "table", "read", "missing", "heading", "list"]);
  const table = report.blocks.find((b) => b.kind === "table");
  assert.deepEqual(table, { kind: "table", columns: ["Customer", "Value", "Days quiet"], rows: [["Cara", "R 84 000", "9"], ["Dan", "R 126 500", "7"]] });
});

test("the assistant's judgement and what the CRM does not hold stay visibly apart from the records", () => {
  const { blocks } = buildReport("q", REPORT);
  assert.deepEqual(blocks.find((b) => b.kind === "read"), { kind: "read", text: "The two waiting on us are the quickest wins." });
  assert.deepEqual(blocks.find((b) => b.kind === "missing"), { kind: "missing", text: "Whether Ben was approved for finance." });
});

test("numbered steps keep their numbers; dashed lists stay bullets", () => {
  const lists = buildReport("q", REPORT).blocks.filter((b) => b.kind === "list");
  assert.deepEqual(lists.map((l) => l.kind === "list" && l.ordered), [false, true]);
  // A change of kind half-way starts a new list rather than renumbering bullets.
  const mixed = buildReport("q", "- one\n- two\n1. first\n2. second").blocks;
  assert.deepEqual(mixed, [
    { kind: "list", items: ["one", "two"], ordered: false },
    { kind: "list", items: ["first", "second"], ordered: true },
  ]);
});

test("nothing the PDF cannot print reaches it: evidence markers, emoji, curly quotes", () => {
  assert.equal(printable("Anna viewed it [[2]] twice [[/quotes/x]] ✅ ."), "Anna viewed it twice.");
  assert.equal(printable("“after month end” — she’s sure 🔥"), "\"after month end\" — she's sure");
  // Every string the PDF will print — not the JSON, whose nested arrays open with "[[" themselves.
  const report = buildReport("q", REPORT);
  const text = [report.title, ...report.blocks.flatMap((b) =>
    b.kind === "list" ? b.items : b.kind === "table" ? [...b.columns, ...b.rows.flat()] : [b.text])].join("\n");
  for (const unprintable of ["[[", "\u26A0", "\u{1F4DE}", "\uFE0F"]) assert.equal(text.includes(unprintable), false, JSON.stringify(unprintable));
});

test("the line pointing at the PDF button is left out of the PDF itself", () => {
  const text = JSON.stringify(buildReport("q", REPORT));
  assert.doesNotMatch(text, /Press PDF/i);
});

test("an ordinary answer, never written as a report, still makes a tidy document", () => {
  const report = buildReport("What should I do with Anna?", "Anna viewed her quote yesterday.\nShe hasn't signed.\n\nMy read: call her this morning.");
  assert.equal(report.title, "What should I do with Anna");
  assert.deepEqual(report.blocks, [
    { kind: "paragraph", text: "Anna viewed her quote yesterday. She hasn't signed." },
    { kind: "read", text: "call her this morning." },
  ]);
});

test("an empty answer still produces a report rather than a blank page or a throw", () => {
  for (const answer of ["", "   \n\n", "[[1]]", "✅"]) {
    const report = buildReport("stuck deals", answer);
    assert.equal(report.blocks.length, 1);
    assert.equal(report.blocks[0].kind, "paragraph");
  }
});

test("a table row that does not fit ends the table — nothing is dropped or squeezed in", () => {
  const { blocks } = buildReport("q", "Columns: A | B\n- 1 | 2\n- only one part\n- 3 | 4");
  assert.deepEqual(blocks, [
    { kind: "table", columns: ["A", "B"], rows: [["1", "2"]] },
    { kind: "list", items: ["only one part", "3 | 4"], ordered: false },
  ]);
});

test("headers with nothing under them, or too many to read on a page, are not drawn as a table", () => {
  assert.deepEqual(buildReport("q", "Columns: A | B\n\nNothing matched.").blocks[0], { kind: "paragraph", text: "A · B" });
  const wide = `Columns: ${Array.from({ length: REPORT_MAX_COLUMNS + 1 }, (_, i) => `C${i}`).join(" | ")}`;
  assert.equal(buildReport("q", `${wide}\n- x`).blocks[0].kind, "paragraph");
});

test("a sentence that happens to end in a colon is not a heading", () => {
  const { blocks } = buildReport("q", "I checked three things. Here they are:\n- one");
  assert.equal(blocks[0].kind, "paragraph");
  assert.equal(buildReport("q", "Waiting on us:\n- one").blocks[0].kind, "heading");
});

test("the title comes from the answer, else from the question with the asking stripped off", () => {
  assert.equal(titleFromQuestion("Can you compile a report on my stuck deals as a PDF?"), "Report on my stuck deals");
  assert.equal(titleFromQuestion("please give me a write-up of Anna's deal"), "Write-up of Anna's deal");
  assert.equal(titleFromQuestion("  ?? "), "Report");
  assert.ok(titleFromQuestion("x".repeat(400)).length <= REPORT_TITLE_CHARS);
  // "Report:" is only a title on the very first line.
  assert.equal(buildReport("stuck deals", "Here it is.\nReport: not a title").title, "Stuck deals");
});

test("the file name is safe to put in a header: letters, digits and dashes only", () => {
  assert.equal(reportFileName("Stuck deals, week of 9 November", "Denago Cape Town"), "denago-cape-town-stuck-deals-week-of-9-november.pdf");
  assert.match(reportFileName('"; rm -rf\r\nSet-Cookie: x=1', "Café ‮ Ltd"), /^[a-z0-9-]+\.pdf$/);
  assert.equal(reportFileName("", ""), "report.pdf");
});

/* ── what DAX is told ─────────────────────────────────────────────── */

test("asking for a report or a PDF is researched in depth, not answered in passing", () => {
  for (const q of ["compile a report on my pipeline", "send me a PDF of this week's quotes", "write-up of Anna's deal please", "Report on overdue follow-ups"]) {
    assert.equal(wantsReport(q), true, q);
    assert.equal(isComplexQuestion(q), true, q);
  }
  for (const q of ["who do I report to?".replace("report to", "answer to"), "what's Anna's number", "any new leads today"]) {
    assert.equal(wantsReport(q), false, q);
  }
});

test("the chat's own marks never reach the paper — bold and links come out as their words", () => {
  assert.equal(printable("The **R185 000** quote for [Anna Jacobs](/leads/cm1) [[2]]"), "The R185 000 quote for Anna Jacobs");
});

test("the report rule changes how an answer is written, never what may be said", () => {
  assert.ok(ANSWER_RULES.includes(REPORT_RULE));
  assert.ok(ANSWER_RULES.startsWith(DATA_RULE), "the data rule still leads");
  // Chat answers may now use bold, lists and small tables (#1091); a REPORT keeps its own shape, which the PDF lays
  // out — so the report rule replaces that formatting, and the rest still holds.
  assert.match(ANSWER_RULES, /Format for reading at a glance/);
  assert.ok(ANSWER_RULES.indexOf("Format for reading at a glance") < ANSWER_RULES.indexOf(REPORT_RULE), "the report rule comes after, and overrides it");
  assert.match(REPORT_RULE, /it replaces the chat formatting above: no \*\*bold\*\* and no \| --- \| tables in a report\. Every other rule above still holds\./);
  assert.match(REPORT_RULE, /Report: <short title>/);
  assert.match(REPORT_RULE, /Columns: A \| B \| C/);
  // The CRM makes and sends the file — to the asker only, never a customer.
  assert.match(REPORT_RULE, /The CRM makes the file and sends it — only to the person who asked, never to a customer/);
  // It never tells them every answer has a PDF.
  assert.match(REPORT_RULE, /A PDF exists only for an answer to a question that asked for a report or a PDF/);
  assert.doesNotMatch(REPORT_RULE, /ANY of your answers|never refuse a PDF/);
  // On WhatsApp it says the PDF follows, and never that it can't be sent there (Sean, 2026-11-14).
  assert.match(REPORT_RULE, /asked on WhatsApp: say the PDF follows in this chat/);
  assert.match(REPORT_RULE, /Never say you can't send it to WhatsApp/);
  assert.match(REPORT_RULE, /write it again now as a report — that is how they get the file/);
});

test("WhatsApp: a report asked for there is followed by its PDF, to the asker only", () => {
  assert.equal(isWrittenAsReport("Report: Open leads in New\n\nThere are 3."), true);
  assert.equal(isWrittenAsReport("  report : Stuck deals"), true);
  assert.equal(isWrittenAsReport("If you mean the report PDF, open the Ask page."), false);
  assert.equal(isWrittenAsReport("There are 3 leads.\nReport: not the first line"), false);
  const wa = code("src/lib/assistantWhatsApp.ts");
  // Only for a question that asked for one AND an answer written as a report.
  assert.match(wa, /if \(answer && wantsReport\(q\) && isWrittenAsReport\(answer\)\) await sendReportPdf\(tenantId, user, waId, q, answer\);/);
  const send = wa.slice(wa.indexOf("async function sendReportPdf("), wa.indexOf("const OUT_OF_TIME"));
  // Made from the answer itself; sent to the same chat with no customer record; a failure says where the PDF is.
  assert.match(send, /renderAssistantReportPdf\(\{ tenantId, preparedFor: user\.name \?\? "", question, answer, answeredAt: new Date\(\) \}\)/);
  assert.match(send, /sendWhatsAppDocument\(waId, \{ content: pdf, filename: fileName, contentType: "application\/pdf" \}, `[^`]*`\);/);
  assert.match(send, /press PDF there/);
  assert.doesNotMatch(send, /askCrm|runTool|findLeads/);
});

test("DAX knows the truth about itself: there is a PDF button, and it sends nothing", () => {
  const about = selfKnowledge("DAX", new Set());
  assert.match(about, /REPORTS AND PDFs/);
  assert.match(about, /business's name and logo in its header/);
  assert.match(about, /nothing is looked up again/);
  assert.match(about, /only the person you answered can download it/);
  assert.match(about, /Your other answers have no PDF button/);
  assert.doesNotMatch(about, /Under every answer/);
  assert.match(about, /You never create, attach or send the file yourself/);
  assert.match(about, /Asked on WhatsApp, the CRM sends that PDF into the same chat straight after your report/);
});

/* ── who may have it, and what the header carries ─────────────────── */

test("only the person who was answered can download the report", () => {
  const route = code("src/app/api/pdf/assistant-report/[turnId]/route.tsx");
  // Looked up by the answer's id, their own user id AND the workspace being acted in (review of #1093) — someone
  // else's id, or another workspace's, is a 404. The workspace is resolved BEFORE the lookup.
  const tenantAt = route.indexOf("const tenantId = ownedWriteTenantId();");
  assert.ok(tenantAt > 0 && tenantAt < route.indexOf("findReportTurn(tenantId, user.id, String(turnId))"), "workspace first");
  assert.match(code("src/lib/assistantReportTurn.ts"), /where: \{ id: turnId, userId, tenantId \}/);
  assert.doesNotMatch(route, /assistantTurn\.findFirst/, "one lookup, the scoped one");
  assert.match(code("package.json"), /"test:assistant-report-tenant"/, "proved against a real database with enforcement off");
  assert.match(route, /if \(!turn \|\| !turn\.answer\.trim\(\)\) return new Response\("Not found", \{ status: 404 \}\)/);
  // Signed in, allowed to use the assistant, in a workspace that has it, scoped to that workspace.
  assert.match(route, /withActingStaffScope\(/);
  assert.match(route, /requireApiUser\(\)/);
  assert.match(route, /hasAnyPermission\(user, \.\.\.ASSISTANT_PERMISSIONS\)/);
  assert.match(route, /isModuleEnabled\("automation"\)/);
  // A private answer is never left in a shared cache.
  assert.match(route, /"Cache-Control": "private, no-store"/);
});

test("the report is the stored answer and nothing else — no lookup runs to make it", () => {
  const route = code("src/app/api/pdf/assistant-report/[turnId]/route.tsx");
  const pdf = code("src/lib/assistantReportPdf.tsx");
  assert.match(route, /question: turn\.question, answer: turn\.answer, answeredAt: turn\.createdAt/);
  assert.match(pdf, /buildReport\(input\.question, input\.answer\)/);
  for (const file of [route, pdf]) assert.doesNotMatch(file, /askCrm|runTool|findLeads|findQuotes|leadBrief|codexRespond/);
  // And it says when its figures were true.
  assert.match(pdf, /answeredAt: formatDateTime\(input\.answeredAt, regional\)/);
  // Every setting read for the NAMED workspace, never the ambient one.
  assert.doesNotMatch(pdf, /getSetting\(|getRegionalSettings\(|getCompanyProfile\(\)/);
  assert.match(pdf, /getCompanyProfile\(tenantId\)/);
});

test("the header carries the business's name and logo on every page", () => {
  const doc = code("src/lib/pdf/AssistantReportDoc.tsx");
  assert.match(doc, /<View style=\{\[s\.header, [^\]]*\]\} fixed>/);
  // Drawn as it is, or on a dark panel when it is light lettering on transparency (tests/logoTone.test.ts).
  assert.match(doc, /<Image src=\{\{ data: meta\.logo, format: "png" \}\} style=\{s\.logoOnPanel\} \/>/);
  assert.match(doc, /\) : meta\.logo \? \((?:\s|\/\/[^\n]*\n)*<Image src=\{\{ data: meta\.logo, format: "png" \}\} style=\{s\.logo\} \/>/);
  assert.match(doc, /\{meta\.companyName\}/);
  const pdf = code("src/lib/assistantReportPdf.tsx");
  assert.match(pdf, /companyName: company\.name/);
  assert.match(pdf, /const logo = await reportLogoPng\(tenantId, company\.logoUrl\);/);
  assert.match(pdf, /\n\s*logo,\n/);
  // The footer too: who it was compiled for, and that it is a snapshot.
  assert.match(doc, /<View style=\{s\.footer\} fixed>/);
  assert.match(doc, /A snapshot: figures may have changed since/);
});

test("the footer is drawn: no line height on the page style, which makes react-pdf drop it", () => {
  const doc = code("src/lib/pdf/AssistantReportDoc.tsx");
  const page = doc.match(/\n  page: \{[^}]*\}/)?.[0] ?? "";
  assert.ok(page, "the page style is there");
  assert.doesNotMatch(page, /lineHeight/);
});

test("the logo is read from the workspace's own storage, or fetched only from a host we vouch for", () => {
  const logo = code("src/lib/assistantReportLogo.ts");
  // Its own uploaded brand logo: by storage key, for THIS workspace.
  assert.match(logo, /readManagedBlob\(`branding\/\$\{tenantId\}\/\$\{asset\}`\)/);
  // A typed URL: https, an allowed host, no redirects, a time limit and a size limit.
  assert.match(logo, /if \(url\.protocol !== "https:"\) return null/);
  assert.match(logo, /if \(!pdfImageHostAllowed\(url\.hostname, \{[^}]*tenantHosts \}\)\) return null/);
  assert.match(logo, /redirect: "error"/);
  assert.match(logo, /AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/);
  assert.match(logo, /MAX_LOGO_BYTES/);
  // A logo that fails never fails the report.
  assert.match(logo, /catch \(error\) \{[\s\S]*return null;\s*\}/);
});

test("a PDF is made only when asked for: the button and the route follow the same rule", () => {
  const chat = code("src/components/AssistantChat.tsx");
  // The button: only under an answer to a question that asked for a report or a PDF.
  assert.match(chat, /turn\.turnId && turn\.answer && !turn\.stopped && wantsReport\(turn\.question\) && <ReportLink turnId=\{turn\.turnId\} \/>/);
  assert.equal((chat.match(/<ReportLink /g) ?? []).length, 1, "offered in one place only");
  // The route: an answer to any other question is refused, even with its id in hand.
  const route = code("src/app/api/pdf/assistant-report/[turnId]/route.tsx");
  assert.match(route, /if \(!wantsReport\(turn\.question\)\) return new Response\("Not found", \{ status: 404 \}\)/);
  assert.match(chat, /href=\{`\/api\/pdf\/assistant-report\/\$\{encodeURIComponent\(turnId\)\}`\}/);
});
