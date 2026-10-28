/**
 * AN INVOICE PRINTS ITS OWN WORKSPACE'S LAYOUT AND BANKING — WITH TENANT
 * ENFORCEMENT OFF (found in the review of #925).
 *
 * The invoice prints the workspace's published invoice layout, with the bank
 * details, payment terms and clauses still written on the old form editor's
 * template — or, until a layout is published, the old page with that template.
 * Both lookups named no workspace, and the scoped client adds one only while
 * enforcement is on. With it off — the default, and the rollback mode — one
 * workspace's invoice could print another's layout and bank account, and a
 * `?tpl=` preview id could print another workspace's template.
 *
 * Two real workspaces, each with its own published invoice and its own banking
 * on both paths, plus an invoice layout and an old template with NO workspace —
 * marked default and newest, so that an unscoped pick takes them first. Driven
 * through the real print code as a signed-in member of each
 * (scripts/harness/actAs.ts), for each workspace's own quote, in both modes,
 * off first, and every verdict read from what would print.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { newBlock } from "../src/lib/doceditor/factory";
import type { DocumentModel } from "../src/lib/doceditor/model";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { actingLayoutScope } from "../src/lib/docbuilder/store";
import { publishedBuilderTemplateFor } from "../src/lib/docbuilder/published";
import { getDocTemplate } from "../src/lib/docTemplateStore";
import { renderQuoteBuilderDocHtml } from "../src/lib/quoteBuilderDocPrint";
import { publishBuilderVersion } from "../src/app/actions/docbuilder";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

/** Each party's banking, as it would print: typed into the layout, and on the old form editor's template. */
const bank = {
  a: { typed: `Alpha Bank ${SFX}`, account: `A-${SFX}-1111`, legacy: `Alpha Legacy Bank ${SFX}` },
  b: { typed: `Bravo Bank ${SFX}`, account: `B-${SFX}-2222`, legacy: `Bravo Legacy Bank ${SFX}` },
  nobody: { typed: `Nobody Bank ${SFX}`, account: `N-${SFX}-0000`, legacy: `Nobody Legacy Bank ${SFX}` },
};
type Party = keyof typeof bank;

/**
 * The standard invoice with this party's bank typed in, plus a banking section
 * that reads {{invoice.bankingDetails}} — the old form editor's text, which the
 * printed invoice fills in from the template.
 */
function invoiceLayout(party: Party): DocumentModel {
  const doc = JSON.parse(
    JSON.stringify(standardTemplateFor("invoice"))
      .replace("Bank: (add your bank)", `Bank: ${bank[party].typed}`)
      .replace("Account number: (add your account number)", `Account number: ${bank[party].account}`),
  ) as DocumentModel;
  const section = newBlock("conditional");
  const card = newBlock("infoCard");
  if (section.type === "conditional" && card.type === "infoCard") {
    section.when = "invoice.bankingDetails";
    card.label = "BANKING";
    card.name = "";
    card.lines = "{{invoice.bankingDetails}}";
    section.blocks = [card];
  }
  doc.pages[0].rows[0].columns[0].blocks.push(section);
  return doc;
}

/** Every foreign party's banking that appears in `text`, by name. */
const foreignBanking = (text: string, own: Party | null) =>
  (Object.keys(bank) as Party[])
    .filter((party) => party !== own)
    .flatMap((party) => [bank[party].typed, bank[party].account, bank[party].legacy].filter((marker) => text.includes(marker)));

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`iv${SFX}`);
  const { a, b } = fixture;
  const templates: string[] = [];
  const records: string[] = [];
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  /** A published layout, the way Publish leaves one: the row, and its version 1 snapshot. */
  const publish = async (tenantId: string | null, name: string, doc: DocumentModel, updatedAt: Date) => {
    const row = await basePrisma.docBuilderTemplate.create({
      data: { tenantId, key: "invoice", name, data: doc as object, isDefault: true, status: "published", publishedVersion: 1, updatedAt },
      select: { id: true },
    });
    templates.push(row.id);
    await basePrisma.docBuilderVersion.create({ data: { tenantId, templateId: row.id, version: 1, data: doc as object, label: "Published", publishedBy: "harness" } });
    return row.id;
  };
  /** The old form editor's invoice template (bank details, payment terms) for one party. */
  const formEditorTemplate = async (tenantId: string | null, party: Party) => {
    const row = await basePrisma.docTemplateRecord.create({
      data: { tenantId, docType: "invoice", name: `Invoice ${party} ${SFX}`, isDefault: true, config: { bodyText: `Bank: ${bank[party].legacy}` } },
      select: { id: true },
    });
    records.push(row.id);
    return row.id;
  };

  try {
    const aInvoice = await publish(a.tenantId, `A invoice ${SFX}`, invoiceLayout("a"), at(58));
    const aRecord = await formEditorTemplate(a.tenantId, "a");
    const bInvoice = await publish(b.tenantId, `B invoice ${SFX}`, invoiceLayout("b"), at(59));
    const bRecord = await formEditorTemplate(b.tenantId, "b");
    // Nobody's: default and newest, so an unscoped pick takes it first.
    const nobodysInvoice = await publish(null, `Nobody's invoice ${SFX}`, invoiceLayout("nobody"), at(61));
    await formEditorTemplate(null, "nobody");

    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      console.log(`\nInvoices, two workspaces — tenant enforcement ${enforcing ? "ON" : "off"}`);
      const memberOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { enforcing });
      const memberOfB = <T>(work: () => Promise<T>) => actAsStaff(b, work, { enforcing });

      // ── the published layout, printed ────────────────────────────────────
      const forA = (await memberOfA(() => renderQuoteBuilderDocHtml({ quoteId: a.rows.quoteId, key: "invoice" }))) ?? "";
      check("A's invoice prints from A's published layout, with A's bank typed in", forA.includes(bank.a.typed) && forA.includes(bank.a.account), forA ? "" : "nothing rendered");
      check("…and A's bank details from A's own template", forA.includes(bank.a.legacy));
      check("…and no other workspace's banking, nor one with no workspace", foreignBanking(forA, "a").length === 0, foreignBanking(forA, "a").join(", "));
      const forB = (await memberOfB(() => renderQuoteBuilderDocHtml({ quoteId: b.rows.quoteId, key: "invoice" }))) ?? "";
      check("B's invoice prints B's layout and B's bank details", forB.includes(bank.b.typed) && forB.includes(bank.b.legacy), forB ? "" : "nothing rendered");
      check("…and nobody else's", foreignBanking(forB, "b").length === 0, foreignBanking(forB, "b").join(", "));

      // ── the switch the invoice page makes ────────────────────────────────
      const switchA = await memberOfA(async () => (await publishedBuilderTemplateFor("invoice", await actingLayoutScope()))?.id ?? null);
      check("the invoice page's switch, for A, is A's published invoice", switchA === aInvoice, `got ${switchA}`);
      const switchB = await memberOfB(async () => (await publishedBuilderTemplateFor("invoice", await actingLayoutScope()))?.id ?? null);
      check("…and for B, B's", switchB === bInvoice, `got ${switchB}`);

      // ── the old page's template ──────────────────────────────────────────
      const oldPage = await memberOfA(async () => getDocTemplate("invoice", undefined, await actingLayoutScope()));
      const oldText = JSON.stringify(oldPage);
      check("the old invoice page reads A's own template", oldText.includes(bank.a.legacy) && foreignBanking(oldText, "a").length === 0, foreignBanking(oldText, "a").join(", "));
      const preview = await memberOfA(async () => getDocTemplate("invoice", bRecord, await actingLayoutScope()));
      const previewText = JSON.stringify(preview);
      check("?tpl= with B's template id, from A, never prints B's", !previewText.includes(bank.b.legacy) && previewText.includes(bank.a.legacy), foreignBanking(previewText, "a").join(", "));
      const ownPreview = await memberOfA(async () => getDocTemplate("invoice", aRecord, await actingLayoutScope()));
      check("…while A previews its own by id", JSON.stringify(ownPreview).includes(bank.a.legacy));

      // ── publishing: the real action writes the old text into the layout ──
      // Review of #926: Publish wrote in the old form editor's default with no
      // workspace, so B's layout could be published with A's bank details — and
      // then printed, correctly scoped, as B's. Unpublished drafts that still read
      // {{invoice.bankingDetails}}, not defaults, so the print checks above stand.
      const draft = async (tenantId: string, party: Party) => {
        const row = await basePrisma.docBuilderTemplate.create({
          data: { tenantId, key: "invoice", name: `${party} draft ${SFX} ${enforcing ? "on" : "off"}`, data: invoiceLayout(party) as object, isDefault: false, updatedAt: at(-60) },
          select: { id: true },
        });
        templates.push(row.id);
        return row.id;
      };
      const publishedText = async (id: string) => {
        const row = await basePrisma.docBuilderTemplate.findUniqueOrThrow({ where: { id }, select: { publishedVersion: true } });
        if (row.publishedVersion == null) return null;
        const version = await basePrisma.docBuilderVersion.findUniqueOrThrow({ where: { templateId_version: { templateId: id, version: row.publishedVersion } }, select: { data: true } });
        return JSON.stringify(version.data);
      };
      const aDraft = await draft(a.tenantId, "a");
      const bDraft = await draft(b.tenantId, "b");
      const aPublish = await memberOfA(() => publishBuilderVersion(aDraft)).catch((error: unknown) => ({ ok: false, error: String(error) }));
      const aSnapshot = (await publishedText(aDraft)) ?? "";
      check("A publishing its own invoice writes in A's bank details", aPublish.ok === true && aSnapshot.includes(bank.a.legacy), JSON.stringify(aPublish));
      check("…and nobody else's", foreignBanking(aSnapshot, "a").length === 0 && !aSnapshot.includes("invoice.bankingDetails"), foreignBanking(aSnapshot, "a").join(", "));
      const bPublish = await memberOfB(() => publishBuilderVersion(bDraft)).catch((error: unknown) => ({ ok: false, error: String(error) }));
      const bSnapshot = (await publishedText(bDraft)) ?? "";
      check("B publishing its own invoice writes in B's bank details, not A's", bPublish.ok === true && bSnapshot.includes(bank.b.legacy) && foreignBanking(bSnapshot, "b").length === 0, JSON.stringify(bPublish) + foreignBanking(bSnapshot, "b").join(", "));
      const aOther = await draft(a.tenantId, "a");
      const hijack = await memberOfB(() => publishBuilderVersion(aOther)).catch((error: unknown) => ({ ok: false, error: String(error) }));
      check("B publishing A's invoice by its id is refused, and nothing is published", hijack.ok === false && (await publishedText(aOther)) === null, JSON.stringify(hijack));

      // ── a layout with no workspace ───────────────────────────────────────
      const scopeOfA = await memberOfA(() => actingLayoutScope());
      check("with more than one workspace, a layout with no workspace is nobody's", scopeOfA.tenantId === a.tenantId && scopeOfA.includeUnowned === false, JSON.stringify(scopeOfA));
      // The one-workspace branch, through the same query. With enforcement on, the
      // guard adds its own strict `tenantId`, so rows with no workspace stay out.
      const sole = await memberOfA(async () => (await publishedBuilderTemplateFor("invoice", { tenantId: a.tenantId, includeUnowned: true }))?.id ?? null);
      if (enforcing) {
        check("in a one-workspace deployment, under enforcement, the guard still keeps rows with no workspace out", sole === aInvoice, `got ${sole}`);
      } else {
        check("in a one-workspace deployment the query admits rows with no workspace", sole === nobodysInvoice, `got ${sole}`);
      }
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.docBuilderVersion.deleteMany({ where: { templateId: { in: templates } } });
    await basePrisma.docBuilderTemplate.deleteMany({ where: { id: { in: templates } } });
    await basePrisma.docTemplateRecord.deleteMany({ where: { id: { in: records } } });
    await teardown(fixture);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
