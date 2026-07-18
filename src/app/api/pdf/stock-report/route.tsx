import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { requireApiUser, apiAuthErrorResponse } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { formatDateTime } from "@/lib/format";
import { listStockUnits, stockDashboard } from "@/lib/stockPlatform";
import StockReportDoc, { type StockReportMeta } from "@/lib/pdf/StockReportDoc";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  incoming: "Incoming",
  received_pending_check: "Awaiting inspection",
  available: "Available",
  reserved: "Reserved",
  allocated: "Allocated",
  pdi: "PDI",
  ready_for_delivery: "Ready",
  hold: "On hold",
  delivered: "Delivered",
};

const REPORT_LIMIT = 250;

export async function GET(req: Request) {
  // Auth only inside the try — react-pdf JSX must not be constructed in a
  // try/catch (react-hooks/error-boundaries).
  let userName: string;
  try {
    const user = await requireApiUser();
    const canView = (await hasPermission(user, "stock.view")) || (await hasPermission(user, "stock.manage"));
    if (!canView) return new Response("Forbidden", { status: 403 });
    userName = user.name;
  } catch (err) {
    const r = apiAuthErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "all";
  const q = searchParams.get("q") ?? undefined;
  const product = searchParams.get("product") ?? undefined;
  const location = searchParams.get("location") ?? undefined;
  const age = searchParams.get("age") ?? undefined;

  const [units, dashboard, productRow] = await Promise.all([
    listStockUnits({ status, query: q, productId: product, location, age, limit: REPORT_LIMIT }),
    stockDashboard(),
    product ? prisma.product.findUnique({ where: { id: product }, select: { name: true } }) : Promise.resolve(null),
  ]);

  const parts: string[] = [];
  if (status && status !== "all") parts.push(STATUS_LABEL[status] ?? status.replace(/_/g, " "));
  if (productRow?.name) parts.push(productRow.name);
  if (location) parts.push(`Location: ${location}`);
  if (age) parts.push(`Aged ${age}+ days`);
  if (q) parts.push(`Matching “${q}”`);
  const filterSummary = parts.length ? parts.join(" · ") : "All active stock";

  const meta: StockReportMeta = {
    generatedAt: formatDateTime(new Date()),
    generatedBy: userName,
    filterSummary,
    truncated: units.length >= REPORT_LIMIT,
  };

  const buf = Buffer.from(await renderToBuffer(<StockReportDoc units={units} dashboard={dashboard} meta={meta} />));

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="denago-stock-report.pdf"',
    },
  });
}
