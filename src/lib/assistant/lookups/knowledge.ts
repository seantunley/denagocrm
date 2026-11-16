import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { formatZAR } from "../../format";
import { getRegionalSettings } from "../../settings";
import { getCompanyProfile } from "../../companyProfile";
import { searchBotKnowledge } from "../../botKnowledge";
import { isModuleEnabled } from "../../modules/enabled";
import { hasAnyPermission, hasPermission } from "../../permissions";
import { knowledgeProducts } from "../../catalogueLookup";
import { knowledgeArgs } from "../../crmAssistantPlan";
import { ToolOutput, User, dateKey, clip } from "../lookupKit";

/**
 * The business's own knowledge — what makes an answer knowledgeable rather than
 * a lookup: the products and their prices, the approved answers the chatbot is
 * allowed to give (finance, warranty, policies), the company's details and,
 * for people who may see it, competitor intelligence.
 */
export async function knowledge(user: User, raw: z.infer<typeof knowledgeArgs>): Promise<ToolOutput> {
  const { topic } = knowledgeArgs.parse(raw);
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  // The catalogue and its prices, to the people who see them where they work —
  // on leads and in the quote builder. (/products itself is the owner's
  // management screen; reading names and prices is not managing them.)
  const seesProducts = await hasAnyPermission(user, "leads.view_all", "leads.view_owned", "quotes.view_all", "quotes.view_owned", "quotes.create");
  const [company, products, approved] = await Promise.all([
    getCompanyProfile().catch(() => null),
    // A small catalogue whole; a large one where it matches the topic — searched
    // in the database, across ALL of it (lib/catalogueLookup.ts). It used to take
    // the first 60 by name and look inside those, so a product further down the
    // alphabet was never shown, and so could never be quoted.
    seesProducts ? knowledgeProducts(words) : Promise.resolve([]),
    searchBotKnowledge(topic).catch(() => []),
  ]);
  const relevant = products;

  let competitors: unknown[] = [];
  if ((await hasPermission(user, "competitors.view")) && (await isModuleEnabled("automation"))) {
    const rows = await prisma.competitor.findMany({
      where: { deletedAt: null },
      take: 10,
      select: {
        name: true, description: true, tier: true,
        briefs: { orderBy: { createdAt: "desc" }, take: 1, select: { headline: true, body: true, createdAt: true } },
      },
    });
    const mentionsCompetitors = /compet|rival|versus|\bvs\b|compare/i.test(topic);
    competitors = rows
      .filter((c) => mentionsCompetitors || words.some((w) => c.name.toLowerCase().includes(w)))
      .map((c) => ({
        competitor: c.name,
        about: clip(c.description, 300),
        tier: c.tier,
        latestBrief: c.briefs[0] ? { when: dateKey(c.briefs[0].createdAt), headline: c.briefs[0].headline, body: clip(c.briefs[0].body, 1200) } : null,
      }));
  }

  const moneyFmt = await getRegionalSettings();
  return {
    truncated: false,
    data: [{
      company: company ? { name: company.name, tagline: company.tagline, website: company.website, address: company.address } : null,
      products: relevant.map((p) => ({
        // The id a quote_build line names (assistantActions.QUOTE_BUILD_RULE). Without
        // it the assistant knew the product and its price and could not put it on a
        // quote: an id it made up fails the catalogue check and the task is dropped.
        productId: p.id,
        product: p.name,
        category: p.category,
        price: formatZAR(p.basePriceCents, moneyFmt),
        // The colours it comes in, as a quote line names them. None listed = no colour to choose.
        colours: p.colors.map((colour) => colour.name),
        tagline: p.showcaseTagline,
        description: clip(p.description, 300),
        specs: p.showcaseSpecs ? clip(JSON.stringify(p.showcaseSpecs), 400) : null,
      })),
      approvedAnswers: approved.map((k) => ({ title: k.title, answer: clip(k.content, 800) })),
      competitors,
    }],
    rows: relevant.slice(0, 8).map((p) => ({ label: p.name, detail: formatZAR(p.basePriceCents, moneyFmt), href: "/products" })),
  };
}
