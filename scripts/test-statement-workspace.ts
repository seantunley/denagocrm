/**
 * A CUSTOMER STATEMENT PRINTS ITS OWN WORKSPACE'S DESIGN AND BANKING — WITH
 * TENANT ENFORCEMENT OFF (review of #925).
 *
 * The statement's layout is the workspace's published Statement, or else its
 * published INVOICE, converted — the invoice's design and its banking details,
 * both the ones typed into the layout and the ones an older layout still reads
 * from the old form editor. Those lookups named no workspace, and the scoped
 * client adds one only while enforcement is on. With it off — the default, and
 * the rollback mode — workspace A's statement could take B's published layout,
 * or one belonging to nobody, and print another business's bank account for
 * A's customer to pay into.
 *
 * Two real workspaces, each with its own published invoice and its own banking
 * on both paths, B with its own published Statement, and an invoice and an old
 * form-editor record with NO workspace — marked default and newest, so that an
 * unscoped pick takes them first. Driven through the real print path as a
 * signed-in member of each (scripts/harness/actAs.ts), in both modes, off first,
 * and every verdict read from what would print.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { newBlock } from "../src/lib/doceditor/factory";
import type { DocumentModel } from "../src/lib/doceditor/model";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { statementPrintLayout } from "../src/lib/statementDocPrint";
import { actingLayoutScope, ensureBuilderSeeded, getBuilderTemplate, listBuilderTemplates, statementLayoutFromPublishedInvoice } from "../src/lib/docbuilder/store";
import {
  deleteBuilderTemplate,
  publishBuilderVersion,
  renameBuilderTemplate,
  resetBuilderTemplateToStandard,
  setDefaultBuilderTemplate,
} from "../src/app/actions/docbuilder";
import { saveDocEditor } from "../src/app/actions/doceditor";
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

/** What an action did, as a value: a refusal can be a result, a thrown redirect or a thrown error — the row is the verdict. */
const settled = <T>(work: Promise<T>) => work.then((value) => ({ value, threw: null as unknown }), (error: unknown) => ({ value: null, threw: String(error) }));

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

/** Each party's banking, as it would print: typed into the layout, and in the old form editor. */
const bank = {
  a: { typed: `Alpha Bank ${SFX}`, account: `A-${SFX}-1111`, legacy: `Alpha Legacy Bank ${SFX}` },
  b: { typed: `Bravo Bank ${SFX}`, account: `B-${SFX}-2222`, legacy: `Bravo Legacy Bank ${SFX}` },
  nobody: { typed: `Nobody Bank ${SFX}`, account: `N-${SFX}-0000`, legacy: `Nobody Legacy Bank ${SFX}` },
};
const statementMarker = `Bravo statement ${SFX}`;
type Party = keyof typeof bank;

/**
 * The standard invoice with this party's bank typed in, plus a second banking
 * section that still hangs on {{invoice.bankingDetails}} — the text an older
 * layout reads from the old form editor (written in when it converts).
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

/** B's own published Statement, told apart by its title. */
function statementLayout(): DocumentModel {
  return JSON.parse(JSON.stringify(standardTemplateFor("statement")).replace('"title":"STATEMENT"', `"title":"${statementMarker}"`)) as DocumentModel;
}

/** Every foreign party's banking that appears in `text`, by name. */
const foreignBanking = (text: string, own: Party | null) =>
  (Object.keys(bank) as Party[])
    .filter((party) => party !== own)
    .flatMap((party) => [bank[party].typed, bank[party].account, bank[party].legacy].filter((marker) => text.includes(marker)));

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`st${SFX}`);
  const { a, b } = fixture;
  const templates: string[] = [];
  const records: string[] = [];
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  /** A published layout, the way Publish leaves one: the row, and its version 1 snapshot. */
  const publish = async (tenantId: string | null, key: string, name: string, doc: DocumentModel, updatedAt: Date) => {
    const row = await basePrisma.docBuilderTemplate.create({
      data: { tenantId, key, name, data: doc as object, isDefault: true, status: "published", publishedVersion: 1, updatedAt },
      select: { id: true },
    });
    templates.push(row.id);
    await basePrisma.docBuilderVersion.create({ data: { tenantId, templateId: row.id, version: 1, data: doc as object, label: "Published", publishedBy: "harness" } });
    return row.id;
  };
  /** The old form editor's invoice text (bank details, payment terms) for one party. */
  const formEditorText = async (tenantId: string | null, party: Party) => {
    const row = await basePrisma.docTemplateRecord.create({
      data: { tenantId, docType: "invoice", name: `Invoice ${party} ${SFX}`, isDefault: true, config: { bodyText: `Bank: ${bank[party].legacy}` } },
      select: { id: true },
    });
    records.push(row.id);
  };

  try {
    // Each workspace's own invoice and banking; B's own Statement.
    await publish(a.tenantId, "invoice", `A invoice ${SFX}`, invoiceLayout("a"), at(58));
    await formEditorText(a.tenantId, "a");
    await publish(b.tenantId, "invoice", `B invoice ${SFX}`, invoiceLayout("b"), at(59));
    await formEditorText(b.tenantId, "b");

    // ── seeding: one Statement per workspace, from its own invoice ─────────
    // Review of #925: one workspace's valid Statement stopped every other one
    // being seeded. Seeded as each workspace in turn, enforcement off.
    await actAsStaff(a, () => ensureBuilderSeeded());
    await actAsStaff(b, () => ensureBuilderSeeded());
    const seeded = await basePrisma.docBuilderTemplate.findMany({
      where: { key: "statement", deletedAt: null, tenantId: { in: [a.tenantId, b.tenantId] } },
      select: { id: true, tenantId: true, data: true },
    });
    const seedOf = (tenantId: string) => seeded.filter((row) => row.tenantId === tenantId);
    const seedText = (tenantId: string) => JSON.stringify(seedOf(tenantId)[0]?.data ?? null);
    check("A is seeded a Statement of its own, from A's invoice", seedOf(a.tenantId).length === 1 && seedText(a.tenantId).includes(bank.a.typed) && foreignBanking(seedText(a.tenantId), "a").length === 0, `${seedOf(a.tenantId).length} rows`);
    check("…and B one of its own, from B's — A's did not stop it", seedOf(b.tenantId).length === 1 && seedText(b.tenantId).includes(bank.b.typed) && foreignBanking(seedText(b.tenantId), "b").length === 0, `${seedOf(b.tenantId).length} rows`);
    const aSeeded = seedOf(a.tenantId)[0]?.id ?? "";

    const bStatementDoc = statementLayout();
    const bStatement = await publish(b.tenantId, "statement", `B statement ${SFX}`, bStatementDoc, at(60));
    const blankStatement = standardTemplateFor("statement");
    // Nobody's: default and newest, so an unscoped pick takes it first.
    await publish(null, "invoice", `Nobody's invoice ${SFX}`, invoiceLayout("nobody"), at(61));
    await formEditorText(null, "nobody");

    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      console.log(`\nStatements, two workspaces — tenant enforcement ${enforcing ? "ON" : "off"}`);
      const memberOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { enforcing });
      const memberOfB = <T>(work: () => Promise<T>) => actAsStaff(b, work, { enforcing });
      const ownerOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { asOwner: true, enforcing });

      // ── A's Statement is A's alone: B cannot list, open or change it ─────
      const stateOf = (id: string) =>
        basePrisma.docBuilderTemplate.findUniqueOrThrow({
          where: { id },
          select: { name: true, data: true, isDefault: true, status: true, publishedVersion: true, deletedAt: true, updatedAt: true },
        });
      const before = JSON.stringify(await stateOf(aSeeded));
      check("B cannot open A's Statement by its id (the door the editor, previews, exports and actions use)", (await memberOfB(() => getBuilderTemplate(aSeeded))) === null);
      check("…while A can", (await memberOfA(() => getBuilderTemplate(aSeeded)))?.id === aSeeded);
      const listedForB = await memberOfB(() => listBuilderTemplates());
      check("Document Studio's list shows B no Statement of A's", !listedForB.some((row) => row.key === "statement" && row.tenantId === a.tenantId));
      check("…and shows A its own", (await memberOfA(() => listBuilderTemplates())).some((row) => row.id === aSeeded));
      const attempts = {
        save: await settled(memberOfB(() => saveDocEditor(aSeeded, statementLayout()))),
        publish: await settled(memberOfB(() => publishBuilderVersion(aSeeded))),
        reset: await settled(memberOfB(() => resetBuilderTemplateToStandard(aSeeded))),
        rename: await settled(memberOfB(() => renameBuilderTemplate(aSeeded, form({ name: `Renamed by B ${SFX}` })))),
        setDefault: await settled(memberOfB(() => setDefaultBuilderTemplate(aSeeded))),
        remove: await settled(memberOfB(() => deleteBuilderTemplate(aSeeded))),
      };
      check("B saving, publishing, resetting, renaming, defaulting or deleting A's Statement changes nothing", JSON.stringify(await stateOf(aSeeded)) === before, JSON.stringify(attempts).slice(0, 300));
      await settled(memberOfB(() => setDefaultBuilderTemplate(bStatement)));
      check("B making its own Statement the default leaves A's default as it was", JSON.stringify(await stateOf(aSeeded)) === before);

      // ── what prints on A's statement ─────────────────────────────────────
      const forA = JSON.stringify(await memberOfA(() => statementPrintLayout()));
      check("A's statement prints A's banking, typed into its invoice", forA.includes(bank.a.typed) && forA.includes(bank.a.account));
      check("…and A's banking from the old form editor", forA.includes(bank.a.legacy));
      check("…and no other workspace's banking, nor one with no workspace", foreignBanking(forA, "a").length === 0, foreignBanking(forA, "a").join(", "));
      check("…and not B's published Statement", !forA.includes(statementMarker));

      // ── what prints on B's statement ─────────────────────────────────────
      const forB = JSON.stringify(await memberOfB(() => statementPrintLayout()));
      check("B's statement prints B's own published Statement", forB.includes(statementMarker));
      check("…with no other workspace's banking, nor one with no workspace", foreignBanking(forB, "b").length === 0, foreignBanking(forB, "b").join(", "));
      const fromBInvoice = JSON.stringify(await memberOfB(async () => statementLayoutFromPublishedInvoice(await actingLayoutScope())));
      check("B's invoice converted carries B's banking on both paths", fromBInvoice.includes(bank.b.typed) && fromBInvoice.includes(bank.b.legacy));
      check("…and nobody else's", foreignBanking(fromBInvoice, "b").length === 0, foreignBanking(fromBInvoice, "b").join(", "));

      // ── a layout with no workspace ───────────────────────────────────────
      const scopeOfA = await memberOfA(() => actingLayoutScope());
      check("with more than one workspace, a layout with no workspace is nobody's", scopeOfA.tenantId === a.tenantId && scopeOfA.includeUnowned === false, JSON.stringify(scopeOfA));
      // The one-workspace branch, through the same query: there, rows with no
      // workspace are that workspace's (every one provably is) — and the newest
      // default invoice is nobody's.
      // With enforcement on, the guard adds its own strict `tenantId` on top, so
      // a row with no workspace stays out regardless — the stricter rule wins.
      const sole = JSON.stringify(await memberOfA(() => statementLayoutFromPublishedInvoice({ tenantId: a.tenantId, includeUnowned: true })));
      if (enforcing) {
        check("in a one-workspace deployment, under enforcement, the guard still keeps rows with no workspace out", sole.includes(bank.a.typed) && !sole.includes(bank.nobody.typed), foreignBanking(sole, "a").join(", "));
      } else {
        check("in a one-workspace deployment the query admits rows with no workspace", sole.includes(bank.nobody.typed), sole.slice(0, 120));
      }

      // ── resetting a Statement to standard ────────────────────────────────
      // Each mode starts from the drafts as made, so a verdict is this mode's own:
      // B's draft put back, and a fresh Statement of A's own, never published (so
      // A's statements keep printing its invoice, converted) — the one A may reset.
      await basePrisma.docBuilderTemplate.update({ where: { id: bStatement }, data: { data: bStatementDoc as object } });
      const aStatement = await basePrisma.docBuilderTemplate.create({
        data: { tenantId: a.tenantId, key: "statement", name: `A statement ${SFX} ${enforcing ? "on" : "off"}`, data: blankStatement as object, isDefault: false, updatedAt: at(57) },
        select: { id: true },
      });
      templates.push(aStatement.id);
      const draftOf = async (id: string) => JSON.stringify((await basePrisma.docBuilderTemplate.findUniqueOrThrow({ where: { id }, select: { data: true } })).data);

      await ownerOfA(() => resetBuilderTemplateToStandard(bStatement)).catch(() => null);
      const theirs = await draftOf(bStatement);
      check("A resetting B's Statement by its id never writes A's banking into it", foreignBanking(theirs, "b").length === 0, foreignBanking(theirs, "b").join(", "));
      const forBAfter = JSON.stringify(await memberOfB(() => statementPrintLayout()));
      check("…and B's statement still prints B's published Statement", forBAfter.includes(statementMarker) && foreignBanking(forBAfter, "b").length === 0);

      const ownReset = await ownerOfA(() => resetBuilderTemplateToStandard(aStatement.id)).catch((error: unknown) => ({ ok: false, error: String(error) }));
      const mine = await draftOf(aStatement.id);
      check("A resetting its own Statement gets A's invoice, banking and all", ownReset.ok === true && mine.includes(bank.a.typed) && mine.includes(bank.a.legacy), JSON.stringify(ownReset));
      check("…and nobody else's", foreignBanking(mine, "a").length === 0, foreignBanking(mine, "a").join(", "));
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.docBuilderVersion.deleteMany({ where: { templateId: { in: templates } } });
    await basePrisma.docBuilderTemplate.deleteMany({ where: { id: { in: templates } } });
    await basePrisma.docTemplateRecord.deleteMany({ where: { id: { in: records } } });
    // Anything a run seeded or reset into either workspace.
    await basePrisma.docBuilderVersion.deleteMany({ where: { template: { tenantId: { in: [a.tenantId, b.tenantId] } } } });
    await basePrisma.docBuilderTemplate.deleteMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } });
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
