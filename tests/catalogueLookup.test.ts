import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * Finding catalogue products for the assistant, across the WHOLE catalogue.
 *
 * Review of #876: the quote builder took the first 200 products by name and
 * matched inside those; the knowledge lookup took the first 60. A product past
 * the cut could not be quoted even by its exact id, and was never shown.
 *
 * Run against a fake database that applies the same filters Prisma would, over
 * a catalogue far larger than either old limit.
 */

type Product = { id: string; name: string; category: string | null; description: string | null; basePriceCents: number; active: boolean; deletedAt: Date | null; showcaseTagline: null; showcaseSpecs: null };
const state = { products: [] as Product[], queries: [] as Record<string, unknown>[], exactAsked: [] as string[] };

type Text = { equals?: string; contains?: string; mode?: string; in?: string[] };
function passes(row: Product, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((alt) => passes(row, alt));
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const text = cond as Text;
      const have = String(value ?? "").toLowerCase();
      if (text.in !== undefined) return text.in.includes(String(value));
      if (text.equals !== undefined) return text.mode === "insensitive" ? have === text.equals.toLowerCase() : value === text.equals;
      if (text.contains !== undefined) return value != null && (text.mode === "insensitive" ? have.includes(text.contains.toLowerCase()) : String(value).includes(text.contains));
    }
    return value === cond;
  });
}
const fakePrisma = {
  product: {
    count: async ({ where }: { where: Record<string, unknown> }) => state.products.filter((p) => passes(p, where)).length,
    findMany: async ({ where, take, orderBy }: { where: Record<string, unknown>; take?: number; orderBy?: unknown }) => {
      state.queries.push({ where, take });
      const rows = state.products.filter((p) => passes(p, where));
      if (orderBy) rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows.slice(0, take ?? rows.length);
    },
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/catalogueLookup.ts")) {
    if (request === "./db") return { prisma: fakePrisma };
    // The real one folds case in SQL and returns ids from EVERY workspace, on sale or not —
    // narrowing them is the guarded client's job, which is what the lookup must then do.
    if (request === "./ciExact") return {
      ciExactIdFilter: async (target: string, value: string) => {
        assert.equal(target, "productName");
        state.exactAsked.push(value);
        return { id: { in: state.products.filter((p) => p.name.toLowerCase() === value.toLowerCase()).map((p) => p.id) } };
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const require_ = createRequire(import.meta.url);
const { KNOWLEDGE_MATCHES, knowledgeProducts, resolveCatalogueProduct } = require_("../src/lib/catalogueLookup.ts") as typeof import("../src/lib/catalogueLookup");

const product = (id: string, name: string, over: Partial<Product> = {}): Product => ({
  id, name, category: "Vehicles", description: null, basePriceCents: 100_00, active: true, deletedAt: null, showcaseTagline: null, showcaseSpecs: null, ...over,
});

beforeEach(() => {
  // 300 products that sort BEFORE the one being looked for: it is past the old first-200 and first-60 alike.
  state.products = Array.from({ length: 300 }, (_, i) => product(`filler${String(i).padStart(3, "0")}`, `Accessory ${String(i).padStart(3, "0")}`, { category: "Accessories" }));
  state.products.push(
    product("zrover", "Zeta Rover XL", { basePriceCents: 249_900_00 }),
    product("zroverlift", "Zeta Rover XL Lifted", { basePriceCents: 269_900_00 }),
    product("znomad", "Zeta Nomad", { basePriceCents: 234_000_00, description: "A four seater street-legal cart" }),
    product("zgone", "Zeta Withdrawn", { active: false }),
    product("zbinned", "Zeta Binned", { deletedAt: new Date() }),
  );
  state.queries = [];
  state.exactAsked = [];
});

test("A PRODUCT BEYOND THE OLD LIMIT is found — by its exact id", async () => {
  assert.equal(state.products.findIndex((p) => p.id === "zrover") >= 200, true, "the regression case: it sits past the first 200 by name");
  assert.deepEqual(await resolveCatalogueProduct({ productId: "zrover" }), { id: "zrover", name: "Zeta Rover XL", basePriceCents: 249_900_00, category: "Vehicles", description: null, active: true, deletedAt: null, showcaseTagline: null, showcaseSpecs: null });
  // Nothing fetched a page of the catalogue to look inside: every query was for this product, two rows at most.
  assert.ok(state.queries.every((query) => (query.take as number) <= 2), JSON.stringify(state.queries.map((query) => query.take)));
});

test("…and by its name, wherever it sits — with the same one-product rule", async () => {
  assert.equal((await resolveCatalogueProduct({ product: "zeta rover xl" }))?.id, "zrover", "the exact name, whatever the case");
  assert.equal((await resolveCatalogueProduct({ product: "  Zeta   Rover XL " }))?.id, "zrover", "…or the spacing");
  assert.equal((await resolveCatalogueProduct({ product: "Nomad" }))?.id, "znomad", "the only product whose name contains it");
  // "Rover" means two products: no guess.
  assert.equal(await resolveCatalogueProduct({ product: "Rover" }), null);
  // 300 products contain "Accessory": ambiguous, however many there are.
  assert.equal(await resolveCatalogueProduct({ product: "Accessory" }), null);
  assert.equal(await resolveCatalogueProduct({ product: "Golf Buggy" }), null);
  assert.equal(await resolveCatalogueProduct({}), null);
  // A made-up id falls back to the name; with no name it is nothing.
  assert.equal((await resolveCatalogueProduct({ productId: "invented", product: "Zeta Nomad" }))?.id, "znomad");
  assert.equal(await resolveCatalogueProduct({ productId: "invented" }), null);
});

test("only products ON SALE: a withdrawn or binned one cannot be quoted, by id or by name", async () => {
  for (const line of [{ productId: "zgone" }, { product: "Zeta Withdrawn" }, { productId: "zbinned" }, { product: "Zeta Binned" }]) {
    assert.equal(await resolveCatalogueProduct(line), null, JSON.stringify(line));
  }
  assert.ok(state.queries.every((query) => (query.where as { active?: boolean; deletedAt?: null }).active === true && (query.where as { deletedAt?: null }).deletedAt === null));
});

test("the knowledge lookup shows a product from anywhere in a large catalogue", async () => {
  // The old first-60-by-name would have returned only "Accessory 000…059".
  const shown = await knowledgeProducts(["rover"]);
  assert.deepEqual(shown.map((p) => p.id), ["zrover", "zroverlift"]);
  // Matched on description and category too.
  assert.deepEqual((await knowledgeProducts(["seater"])).map((p) => p.id), ["znomad"]);
  // A word that matches hundreds is capped, not unbounded.
  assert.equal((await knowledgeProducts(["accessory"])).length, KNOWLEDGE_MATCHES);
  // No usable word: still shows something rather than nothing.
  assert.equal((await knowledgeProducts([])).length, KNOWLEDGE_MATCHES);
  // A small catalogue is shown whole, whatever was asked.
  state.products = state.products.filter((p) => p.id.startsWith("z"));
  assert.deepEqual((await knowledgeProducts(["nothing-matches"])).map((p) => p.id), ["znomad", "zrover", "zroverlift"]);
});

test("both readers use it — neither keeps a first-N page of the catalogue", () => {
  const lib = readFileSync("src/lib/crmAssistant.ts", "utf8");
  assert.match(lib, /seesProducts \? knowledgeProducts\(words\) : Promise\.resolve\(\[\]\),/);
  // quote_build's lines: the job sheet's (Phase 1), or the proposal's own — resolved the same way.
  assert.match(lib, /const matched = await Promise\.all\(askedLines\.map\(\(line\) => resolveCatalogueProduct\(line\)\)\);/);
  assert.doesNotMatch(lib, /prisma\.product\.findMany\(\{\s*where: \{ active: true, deletedAt: null \},\s*orderBy: \{ name: "asc" \},\s*take: (60|200),/);
  // One rule for what a name means: the lookup hands its candidates to matchCatalogueProduct.
  const lookup = readFileSync("src/lib/catalogueLookup.ts", "utf8");
  assert.match(lookup, /return matchCatalogueProduct\(\[\.\.\.candidates\.values\(\)\], line\);/);
  // The exact name is compared by the project's case-folding helper, never by an unescaped
  // ILIKE (`equals` + `mode: "insensitive"`), where `_` and `%` in a name are wildcards.
  assert.match(lookup, /\.\.\.\(await ciExactIdFilter\("productName", wanted\)\)/);
  assert.doesNotMatch(lookup.replace(/\/\/.*$/gm, ""), /equals: [^,}]+, mode: "insensitive"/);
  assert.match(readFileSync("src/lib/ciExact.ts", "utf8"), /productName: \{ table: "Product", column: "name", fold: "lower" \},/);
});

test("a name with LIKE wildcards in it means only itself — and what the helper returns is still narrowed to what is on sale here", async () => {
  state.products.push(product("zunder", "Zeta_Rover"), product("zother", "ZetaXRover"));
  // "Zeta_Rover" is one product, not also "ZetaXRover" (which an ILIKE on `_` would match).
  assert.equal((await resolveCatalogueProduct({ product: "zeta_rover" }))?.id, "zunder");
  // The helper returns a withdrawn product's id too; the guarded query drops it.
  assert.equal(await resolveCatalogueProduct({ product: "Zeta Withdrawn" }), null);
  assert.ok(state.exactAsked.includes("Zeta Withdrawn"));
});
