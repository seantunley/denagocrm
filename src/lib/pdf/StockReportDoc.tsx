import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import { formatZAR } from "@/lib/format";
import type { StockUnitRecord, StockDashboard } from "@/lib/stockPlatform";

/**
 * Printable stock report — a branded inventory snapshot that honours whatever
 * filters were active on the Stock page. Pure Node render (react-pdf), same
 * approach as the quotation PDF; the unit table flows across as many A4 pages as
 * needed with a repeating header/footer.
 */

const ink = "#020617";
const accent = "#ea580c";
const slate700 = "#334155";
const slate500 = "#64748b";
const slate200 = "#e2e8f0";
const slate50 = "#f8fafc";
const white = "#ffffff";

const STATUS_LABEL: Record<string, string> = {
  incoming: "Incoming",
  received_pending_check: "Awaiting inspection",
  available: "Available",
  reserved: "Reserved",
  allocated: "Allocated",
  pdi: "PDI",
  ready_for_delivery: "Ready",
  delivered: "Delivered",
  sold: "Delivered",
  hold: "On hold",
  damaged: "Damaged",
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, " ");

const s = StyleSheet.create({
  page: { paddingTop: 82, paddingBottom: 52, paddingHorizontal: 32, fontSize: 9, fontFamily: "Helvetica", color: slate700 },
  header: { position: "absolute", top: 0, left: 32, right: 32, marginTop: 22, height: 44, backgroundColor: ink, borderRadius: 5, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  brand: { color: white, fontFamily: "Helvetica-Bold", fontSize: 12, letterSpacing: 1 },
  brandSub: { color: "#94a3b8", fontSize: 6.5, marginTop: 2, letterSpacing: 0.5 },
  docTitle: { color: white, fontFamily: "Helvetica-Bold", fontSize: 13, letterSpacing: 2, textAlign: "right" },
  docDate: { color: accent, fontFamily: "Helvetica-Bold", fontSize: 8, textAlign: "right", marginTop: 2 },
  footer: { position: "absolute", bottom: 24, left: 32, right: 32, borderTopWidth: 1.2, borderTopColor: accent, paddingTop: 6, flexDirection: "row", justifyContent: "space-between" },
  footerLine: { color: slate500, fontSize: 7 },
  pageNo: { color: slate500, fontSize: 7.5 },

  filterLine: { fontSize: 8.5, color: slate500, marginBottom: 12 },
  filterStrong: { color: ink, fontFamily: "Helvetica-Bold" },

  cards: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  card: { width: 96, backgroundColor: slate50, borderRadius: 4, padding: 8, borderLeftWidth: 3, borderLeftColor: ink },
  cardVal: { fontSize: 14, fontFamily: "Helvetica-Bold", color: ink },
  cardLabel: { fontSize: 6.5, color: slate500, marginTop: 2, letterSpacing: 0.4 },

  valueBand: { flexDirection: "row", gap: 12, marginBottom: 16 },
  valueBox: { flex: 1, backgroundColor: slate50, borderRadius: 4, padding: 10 },
  valueLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", letterSpacing: 0.8, color: slate500, marginBottom: 3 },
  valueAmt: { fontSize: 12, fontFamily: "Helvetica-Bold", color: ink },

  tHead: { flexDirection: "row", backgroundColor: ink, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  tHeadCell: { color: white, fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 0.5, paddingVertical: 5, paddingHorizontal: 6 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: slate200 },
  rowAlt: { backgroundColor: slate50 },
  cell: { fontSize: 8, paddingVertical: 5, paddingHorizontal: 6, color: slate700 },

  cStock: { width: 74 },
  cProduct: { flex: 1 },
  cStatus: { width: 78 },
  cLoc: { width: 84 },
  cAge: { width: 34, textAlign: "right" },
  cCost: { width: 62, textAlign: "right" },
  sub: { fontSize: 6.5, color: slate500 },

  totalRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  totalBand: { backgroundColor: accent, borderRadius: 4, flexDirection: "row", gap: 12, paddingVertical: 6, paddingHorizontal: 14 },
  totalLabel: { color: white, fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 0.6 },
  totalAmt: { color: white, fontSize: 11, fontFamily: "Helvetica-Bold" },

  note: { fontSize: 7.5, color: slate500, marginTop: 10, fontFamily: "Helvetica-Oblique" },
  empty: { fontSize: 10, color: slate500, textAlign: "center", marginTop: 40 },
});

export type StockReportMeta = {
  generatedAt: string; // preformatted date/time string
  generatedBy: string;
  filterSummary: string; // human description of active filters, or "All active stock"
  truncated: boolean;
};

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <View style={s.card}>
      <Text style={s.cardVal}>{value}</Text>
      <Text style={s.cardLabel}>{label}</Text>
    </View>
  );
}

export default function StockReportDoc({
  units,
  dashboard,
  meta,
}: {
  units: StockUnitRecord[];
  dashboard: StockDashboard;
  meta: StockReportMeta;
}) {
  const listedValue = units.reduce((sum, u) => sum + (u.landedCostCents || u.costCents || 0), 0);

  return (
    <Document title="Stock Report — Denago Cape Town" author="Denago Cape Town">
      <Page size="A4" style={s.page}>
        <View style={s.header} fixed>
          <View>
            <Text style={s.brand}>DENAGO CAPE TOWN</Text>
            <Text style={s.brandSub}>STOCK OPERATIONS</Text>
          </View>
          <View>
            <Text style={s.docTitle}>STOCK REPORT</Text>
            <Text style={s.docDate}>{meta.generatedAt}</Text>
          </View>
        </View>

        <View style={s.footer} fixed>
          <View>
            <Text style={s.footerLine}>Denago Cape Town — Stock report · generated by {meta.generatedBy}</Text>
            <Text style={s.footerLine}>Confidential — internal inventory record</Text>
          </View>
          <Text style={s.pageNo} render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
        </View>

        <Text style={s.filterLine}>
          <Text style={s.filterStrong}>Scope: </Text>
          {meta.filterSummary} · {units.length} unit{units.length === 1 ? "" : "s"} listed
        </Text>

        {/* Whole-inventory snapshot (not filtered — the operational picture) */}
        <View style={s.cards}>
          <Metric value={dashboard.totalUnits} label="TOTAL UNITS" />
          <Metric value={dashboard.available} label="AVAILABLE" />
          <Metric value={dashboard.incoming} label="INCOMING" />
          <Metric value={dashboard.reserved} label="RESERVED" />
          <Metric value={dashboard.allocated} label="ALLOCATED" />
          <Metric value={dashboard.pdi} label="IN PDI" />
          <Metric value={dashboard.ready} label="READY" />
          <Metric value={dashboard.hold} label="HOLD / DAMAGED" />
        </View>

        <View style={s.valueBand}>
          <View style={s.valueBox}>
            <Text style={s.valueLabel}>AVAILABLE STOCK VALUE (LANDED)</Text>
            <Text style={s.valueAmt}>{formatZAR(dashboard.availableValueCents)}</Text>
          </View>
          <View style={s.valueBox}>
            <Text style={s.valueLabel}>INCOMING STOCK VALUE (LANDED)</Text>
            <Text style={s.valueAmt}>{formatZAR(dashboard.incomingValueCents)}</Text>
          </View>
          <View style={s.valueBox}>
            <Text style={s.valueLabel}>AVG AGE · AGED 60+</Text>
            <Text style={s.valueAmt}>
              {dashboard.averageAgeDays}d · {dashboard.aged60}
            </Text>
          </View>
        </View>

        {/* Unit table */}
        <View style={s.tHead} fixed>
          <Text style={[s.tHeadCell, s.cStock]}>STOCK #</Text>
          <Text style={[s.tHeadCell, s.cProduct]}>UNIT</Text>
          <Text style={[s.tHeadCell, s.cStatus]}>STATUS</Text>
          <Text style={[s.tHeadCell, s.cLoc]}>LOCATION</Text>
          <Text style={[s.tHeadCell, s.cAge]}>AGE</Text>
          <Text style={[s.tHeadCell, s.cCost]}>LANDED</Text>
        </View>

        {units.length === 0 ? (
          <Text style={s.empty}>No stock units match this filter.</Text>
        ) : (
          units.map((u, idx) => (
            <View key={u.id} style={idx % 2 === 1 ? [s.row, s.rowAlt] : s.row} wrap={false}>
              <Text style={[s.cell, s.cStock]}>{u.stockNumber ?? "—"}</Text>
              <View style={[s.cell, s.cProduct]}>
                <Text>{u.productName}</Text>
                <Text style={s.sub}>
                  {[u.color, u.serial ?? "serial pending", u.label].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <Text style={[s.cell, s.cStatus]}>{statusLabel(u.status)}</Text>
              <Text style={[s.cell, s.cLoc]}>{u.location ?? "—"}</Text>
              <Text style={[s.cell, s.cAge]}>{u.ageDays}d</Text>
              <Text style={[s.cell, s.cCost]}>{formatZAR(u.landedCostCents || u.costCents)}</Text>
            </View>
          ))
        )}

        {units.length > 0 && (
          <View style={s.totalRow} wrap={false}>
            <View style={s.totalBand}>
              <Text style={s.totalLabel}>LISTED LANDED VALUE</Text>
              <Text style={s.totalAmt}>{formatZAR(listedValue)}</Text>
            </View>
          </View>
        )}

        {meta.truncated && (
          <Text style={s.note}>
            Showing the first {units.length} units for this filter. Narrow the filter on the Stock page to report on a
            specific subset.
          </Text>
        )}
      </Page>
    </Document>
  );
}
