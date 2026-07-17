import { NextResponse } from "next/server";
import { requireApiUser, apiAuthErrorResponse } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { stockExportRows } from "@/lib/stockPlatform";

function cell(value: string | number | null | undefined) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET() {
  try {
    const user = await requireApiUser();
    if (!(await hasAnyPermission(user, "stock.view", "stock.manage"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const rows = await stockExportRows();
    const headers = rows[0] ? Object.keys(rows[0]) : [
      "Stock number", "Model", "Colour", "Serial / VIN", "Status", "Condition",
      "Location", "Arrived at", "Age days", "Landed cost", "Sale value",
      "Reserved lead", "Quote number", "PDI",
    ];
    const csv = [
      headers.map(cell).join(","),
      ...rows.map((row) => headers.map((header) => cell(row[header])).join(",")),
    ].join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="denago-stock-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Unable to export stock" }, { status: 500 });
  }
}
