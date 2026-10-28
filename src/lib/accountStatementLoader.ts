import "server-only";
import { actingTenantId } from "./actingTenant";
import { buildAccountStatement, isStatementInvoice, type AccountStatement, type StatementQuote } from "./accountStatement";
import { prisma } from "./db";
import { getAccessibleQuoteIds, hasPermission, type PermissionUser } from "./permissions";
import { loadBillToFleet, loadBillToFleets, quoteBillTo, type QuoteBillTo } from "./quoteBillTo";

/**
 * WHICH invoices and payments belong on an account's statement — the half of
 * statements that touches the database. The arithmetic is accountStatement.ts.
 *
 * WHOSE DEBT IT IS follows the invoice's own addressee (quoteBillTo.ts): a quote
 * billed to a fleet account is the BUSINESS's debt and goes on the fleet's
 * statement, not on the statement of the manager who signed it. A quote whose
 * fleet no longer resolves (deleted, or another workspace's id) is billed to the
 * person, exactly as its printed invoice is.
 *
 * EVERY QUERY NAMES THE WORKSPACE (`actingTenantId()`), the same rule as the
 * fleet page and the fulfilment actions: the db.ts guard scopes nothing while
 * enforcement is dormant, and a statement pooled across workspaces would send one
 * customer another's figures.
 *
 * A PARTIAL STATEMENT IS REFUSED, NOT PRINTED. A viewer who may open this
 * customer but not every one of its invoices gets `kind: "partial"` — a
 * statement missing an invoice states the wrong balance, and is worse than none.
 */

export type LoadedStatement =
  | {
      kind: "ok";
      accountName: string;
      billTo: QuoteBillTo;
      statement: AccountStatement;
      /** Invoices this person signed that are billed to a fleet account instead. */
      billedElsewhere: { fleetId: string; fleetName: string; count: number }[];
    }
  | { kind: "partial" }
  | { kind: "missing" };

const QUOTE_INCLUDE = { items: true, fees: true } as const;

async function viewerSeesEveryQuote(user: PermissionUser, quotes: { id: string; deletedAt: Date | null }[]): Promise<boolean> {
  if (await hasPermission(user, "quotes.view_all")) return true;
  const allowed = new Set(await getAccessibleQuoteIds(user));
  // A trashed quote is in nobody's list; it only ever contributes a staff warning.
  return quotes.filter((quote) => !quote.deletedAt).every((quote) => allowed.has(quote.id));
}

async function paymentsFor(tenantId: string, quotes: StatementQuote[]) {
  if (!quotes.length) return [];
  return prisma.quotePayment.findMany({
    where: { tenantId, quoteId: { in: quotes.map((quote) => quote.id) } },
    orderBy: { receivedAt: "asc" },
  });
}

export async function loadContactStatement(
  user: PermissionUser,
  contactId: string,
  fmt: (cents: number) => string,
): Promise<LoadedStatement> {
  const tenantId = await actingTenantId();
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId, deletedAt: null } });
  if (!contact) return { kind: "missing" };

  const quotes = await prisma.quote.findMany({ where: { contactId, tenantId }, include: QUOTE_INCLUDE });
  const fleets = await loadBillToFleets(prisma, quotes.map((quote) => quote.fleetId));
  const own = quotes.filter((quote) => !quote.fleetId || !fleets.has(quote.fleetId));
  if (!(await viewerSeesEveryQuote(user, own))) return { kind: "partial" };

  const elsewhere = new Map<string, { fleetId: string; fleetName: string; count: number }>();
  for (const quote of quotes) {
    const fleet = quote.fleetId ? fleets.get(quote.fleetId) : undefined;
    if (!fleet || !isStatementInvoice(quote)) continue;
    const entry = elsewhere.get(fleet.id) ?? { fleetId: fleet.id, fleetName: fleet.name, count: 0 };
    entry.count += 1;
    elsewhere.set(fleet.id, entry);
  }

  const billTo = quoteBillTo({ contact, fleetId: null }, null);
  return {
    kind: "ok",
    accountName: billTo.name,
    billTo,
    statement: buildAccountStatement(own, await paymentsFor(tenantId, own), fmt),
    billedElsewhere: [...elsewhere.values()],
  };
}

export async function loadFleetStatement(
  user: PermissionUser,
  fleetId: string,
  fmt: (cents: number) => string,
): Promise<LoadedStatement> {
  const tenantId = await actingTenantId();
  const fleet = await loadBillToFleet(prisma, fleetId);
  if (!fleet) return { kind: "missing" };
  const account = await prisma.fleet.findFirst({ where: { id: fleetId, tenantId, deletedAt: null }, select: { contactId: true } });
  if (!account) return { kind: "missing" };
  const manager = account.contactId
    ? await prisma.contact.findFirst({ where: { id: account.contactId, tenantId, deletedAt: null } })
    : null;

  const quotes = await prisma.quote.findMany({ where: { fleetId, tenantId }, include: QUOTE_INCLUDE });
  if (!(await viewerSeesEveryQuote(user, quotes))) return { kind: "partial" };

  const billTo = quoteBillTo({ contact: manager, fleetId }, fleet);
  return {
    kind: "ok",
    accountName: fleet.name,
    billTo,
    statement: buildAccountStatement(quotes, await paymentsFor(tenantId, quotes), fmt),
    billedElsewhere: [],
  };
}

/** The "Statement for" block, in the same order the invoice prints it. */
export function statementBillToLines(billTo: QuoteBillTo): string[] {
  return [
    billTo.name,
    billTo.attention ? `Attention: ${billTo.attention}` : "",
    billTo.phone,
    billTo.email,
    ...(billTo.addressLines ?? [billTo.address]),
    billTo.registrationNumber ? `Reg no: ${billTo.registrationNumber}` : "",
    billTo.vatNumber ? `VAT no: ${billTo.vatNumber}` : "",
  ].filter(Boolean);
}
