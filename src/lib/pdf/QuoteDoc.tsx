import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import type { QuoteForPrint } from "@/components/print/QuotePrintDoc";

/**
 * SPIKE — the quotation rebuilt with @react-pdf/renderer instead of fixed mm
 * boxes. Content flows and paginates like a word processor: the line-item table
 * spans as many pages as it needs, while the branded header and footer (with
 * page numbers) repeat on every page. Pure Node render — no Chromium.
 */

const ink = "#020617";
const accent = "#ea580c";
const slate700 = "#334155";
const slate500 = "#64748b";
const slate200 = "#e2e8f0";
const slate50 = "#f8fafc";
const white = "#ffffff";

const s = StyleSheet.create({
  page: {
    paddingTop: 84,
    paddingBottom: 60,
    paddingHorizontal: 40,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: slate700,
  },
  // Repeating brand banner (fixed → every page)
  header: {
    position: "absolute",
    top: 0,
    left: 40,
    right: 40,
    marginTop: 24,
    height: 44,
    backgroundColor: ink,
    borderRadius: 5,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  brand: { color: white, fontFamily: "Helvetica-Bold", fontSize: 12, letterSpacing: 1 },
  brandSub: { color: "#94a3b8", fontSize: 6.5, marginTop: 2, letterSpacing: 0.5 },
  docTitle: { color: white, fontFamily: "Helvetica-Bold", fontSize: 14, letterSpacing: 3, textAlign: "right" },
  docNumber: { color: accent, fontFamily: "Helvetica-Bold", fontSize: 10, textAlign: "right", marginTop: 2 },
  // Repeating footer (fixed)
  footer: {
    position: "absolute",
    bottom: 26,
    left: 40,
    right: 40,
    borderTopWidth: 1.2,
    borderTopColor: accent,
    paddingTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  footerBold: { fontFamily: "Helvetica-Bold", color: slate700, fontSize: 7.5 },
  footerLine: { color: slate500, fontSize: 7 },
  pageNo: { color: slate500, fontSize: 7.5 },

  metaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  meta: { color: slate500, fontSize: 8.5 },

  cards: { flexDirection: "row", gap: 12, marginBottom: 18 },
  card: { flex: 1, backgroundColor: slate50, borderRadius: 4, padding: 10, borderLeftWidth: 3 },
  cardLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 4 },
  cardName: { fontSize: 10, fontFamily: "Helvetica-Bold", color: ink, marginBottom: 2 },
  cardLine: { fontSize: 8, color: slate500, marginBottom: 1 },

  tHead: { flexDirection: "row", backgroundColor: ink, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  tHeadCell: { color: white, fontSize: 7.5, fontFamily: "Helvetica-Bold", letterSpacing: 0.6, paddingVertical: 6, paddingHorizontal: 8 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: slate200 },
  rowAlt: { backgroundColor: slate50 },
  cell: { fontSize: 9, paddingVertical: 6, paddingHorizontal: 8, color: slate700 },
  cDesc: { flex: 1 },
  cNum: { width: 70, textAlign: "right" },

  totalWrap: { flexDirection: "row", justifyContent: "flex-end", marginTop: 14 },
  totalBand: { backgroundColor: accent, borderRadius: 4, flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 16, gap: 14 },
  totalLabel: { color: white, fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 1 },
  totalAmount: { color: white, fontSize: 15, fontFamily: "Helvetica-Bold" },

  section: { marginTop: 20 },
  sectionBox: { backgroundColor: slate50, borderRadius: 4, padding: 10 },
  sectionLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", letterSpacing: 1, color: slate500, marginBottom: 5 },
  termLine: { fontSize: 8.5, color: slate500, marginBottom: 2, lineHeight: 1.4 },

  sigs: { flexDirection: "row", gap: 40, marginTop: 46 },
  sig: { flex: 1 },
  sigLine: { borderTopWidth: 1.4, borderTopColor: ink, marginTop: 34, paddingTop: 5 },
  sigLabel: { fontSize: 8, color: slate500 },
  sigScript: { fontFamily: "Helvetica-Oblique", fontSize: 16, color: ink, marginBottom: 2 },
  sigEvidence: { fontSize: 7.5, color: slate500, lineHeight: 1.4 },

  // Certificate of completion
  certTitle: { fontFamily: "Helvetica-Bold", fontSize: 15, letterSpacing: 2, color: ink, marginBottom: 4 },
  certLead: { fontSize: 9, color: slate500, marginBottom: 18 },
  certRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: slate200, paddingVertical: 6 },
  certKey: { width: 130, fontSize: 8.5, fontFamily: "Helvetica-Bold", color: slate700 },
  certVal: { flex: 1, fontSize: 8.5, color: slate700 },
  certSeal: { marginTop: 20, backgroundColor: slate50, borderLeftWidth: 3, borderLeftColor: accent, borderRadius: 4, padding: 12 },
  certSealLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", letterSpacing: 1, color: accent, marginBottom: 5 },
  certSealText: { fontSize: 8.5, color: slate700, lineHeight: 1.5 },
});

export type SignedInfo = { name: string; email: string; ip: string; date: string };

export default function QuoteDoc({ quote, signed }: { quote: QuoteForPrint; signed?: SignedInfo }) {
  const total = quote.items.reduce((sum, i) => sum + i.qty * i.unitPriceCents, 0);
  const customerName = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
  const phone = quote.contact?.phone ?? quote.lead?.phone ?? "";
  const email = quote.contact?.email ?? quote.lead?.email ?? "";
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city, quote.contact.province, quote.contact.postalCode]
        .filter(Boolean)
        .join(", ")
    : "";
  const vehicle = quote.lead?.product?.name ?? quote.items[0]?.description ?? "—";
  const terms = (quote.terms ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•\-*]+/, "").trim())
    .filter(Boolean);

  return (
    <Document title={`Quotation Q-${quote.number}`} author="Denago Cape Town">
      <Page size="A4" style={s.page}>
        {/* Repeating brand banner */}
        <View style={s.header} fixed>
          <View>
            <Text style={s.brand}>DENAGO CAPE TOWN</Text>
            <Text style={s.brandSub}>AUTHORIZED DENAGO EV DEALER</Text>
          </View>
          <View>
            <Text style={s.docTitle}>QUOTATION</Text>
            <Text style={s.docNumber}>Q-{quote.number}</Text>
          </View>
        </View>

        {/* Repeating footer with page numbers */}
        <View style={s.footer} fixed>
          <View>
            <Text style={s.footerBold}>Denago Cape Town — Authorized Denago EV Dealer</Text>
            <Text style={s.footerLine}>Unit 55, M5 Freeway Business Park, Maitland, Cape Town · 073 789 3438</Text>
            <Text style={s.footerLine}>sales@denagocpt.co.za · denagocpt.co.za · @denago_capetown</Text>
          </View>
          <Text style={s.pageNo} render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
        </View>

        {/* Meta strip */}
        <View style={s.metaRow}>
          <Text style={s.meta}>Date: {formatDate(quote.createdAt)}</Text>
          {quote.validUntil ? <Text style={s.meta}>Valid until: {formatDate(quote.validUntil)}</Text> : <Text />}
          {quote.createdBy ? <Text style={s.meta}>Prepared by: {quote.createdBy.name}</Text> : <Text />}
        </View>

        {/* Customer / vehicle cards */}
        <View style={s.cards}>
          <View style={[s.card, { borderLeftColor: accent }]}>
            <Text style={[s.cardLabel, { color: accent }]}>PREPARED FOR</Text>
            <Text style={s.cardName}>{customerName || "—"}</Text>
            {phone ? <Text style={s.cardLine}>{phone}</Text> : null}
            {email ? <Text style={s.cardLine}>{email}</Text> : null}
            {address ? <Text style={s.cardLine}>{address}</Text> : null}
          </View>
          <View style={[s.card, { borderLeftColor: ink }]}>
            <Text style={[s.cardLabel, { color: slate500 }]}>VEHICLE OF INTEREST</Text>
            <Text style={s.cardName}>{vehicle}</Text>
            {quote.lead?.color ? <Text style={s.cardLine}>Colour: {quote.lead.color}</Text> : null}
            <Text style={s.cardLine}>Demo drives available at your estate or our Maitland showroom.</Text>
          </View>
        </View>

        {/* Line items — flows across pages */}
        <View style={s.tHead} fixed>
          <Text style={[s.tHeadCell, s.cDesc]}>DESCRIPTION</Text>
          <Text style={[s.tHeadCell, s.cNum]}>QTY</Text>
          <Text style={[s.tHeadCell, s.cNum]}>UNIT PRICE</Text>
          <Text style={[s.tHeadCell, s.cNum]}>TOTAL</Text>
        </View>
        {quote.items.map((i, idx) => (
          <View key={i.id} style={idx % 2 === 1 ? [s.row, s.rowAlt] : s.row} wrap={false}>
            <Text style={[s.cell, s.cDesc]}>{i.description}</Text>
            <Text style={[s.cell, s.cNum]}>{i.qty}</Text>
            <Text style={[s.cell, s.cNum]}>{formatZAR(i.unitPriceCents)}</Text>
            <Text style={[s.cell, s.cNum, { fontFamily: "Helvetica-Bold" }]}>
              {formatZAR(Math.round(i.qty * i.unitPriceCents))}
            </Text>
          </View>
        ))}

        {/* Total */}
        <View style={s.totalWrap} wrap={false}>
          <View style={s.totalBand}>
            <Text style={s.totalLabel}>TOTAL INCL. VAT</Text>
            <Text style={s.totalAmount}>{formatZAR(Math.round(total))}</Text>
          </View>
        </View>

        {/* Terms */}
        {terms.length > 0 && (
          <View style={s.section} wrap={false}>
            <View style={s.sectionBox}>
              <Text style={s.sectionLabel}>TERMS</Text>
              {terms.map((line, i) => (
                <Text key={i} style={s.termLine}>
                  • {line}
                </Text>
              ))}
            </View>
          </View>
        )}

        {/* Signatures */}
        <View style={s.sigs} wrap={false}>
          <View style={s.sig}>
            {signed ? (
              <>
                <Text style={s.sigScript}>{signed.name}</Text>
                <View style={s.sigLine}>
                  <Text style={s.sigEvidence}>
                    Accepted — signed electronically by {signed.name} on {signed.date} · IP {signed.ip} · ECT Act, 2002
                  </Text>
                </View>
              </>
            ) : (
              <View style={s.sigLine}>
                <Text style={s.sigLabel}>Accepted — customer signature &amp; date</Text>
              </View>
            )}
          </View>
          <View style={s.sig}>
            <View style={s.sigLine}>
              <Text style={s.sigLabel}>For Denago Cape Town &amp; date</Text>
            </View>
          </View>
        </View>
      </Page>

      {/* Certificate of Completion — appended only for a signed document */}
      {signed && (
        <Page size="A4" style={s.page}>
          <View style={s.header} fixed>
            <View>
              <Text style={s.brand}>DENAGO CAPE TOWN</Text>
              <Text style={s.brandSub}>AUTHORIZED DENAGO EV DEALER</Text>
            </View>
            <View>
              <Text style={s.docTitle}>CERTIFICATE</Text>
              <Text style={s.docNumber}>Q-{quote.number}</Text>
            </View>
          </View>
          <View style={s.footer} fixed>
            <View>
              <Text style={s.footerBold}>Denago Cape Town — Authorized Denago EV Dealer</Text>
              <Text style={s.footerLine}>sales@denagocpt.co.za · denagocpt.co.za</Text>
            </View>
            <Text style={s.pageNo} render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
          </View>

          <Text style={s.certTitle}>CERTIFICATE OF COMPLETION</Text>
          <Text style={s.certLead}>
            Audit record for Quotation Q-{quote.number}, signed electronically and sealed by Denago Cape Town.
          </Text>

          <View style={s.certRow}>
            <Text style={s.certKey}>Document</Text>
            <Text style={s.certVal}>Quotation Q-{quote.number}</Text>
          </View>
          <View style={s.certRow}>
            <Text style={s.certKey}>Signer</Text>
            <Text style={s.certVal}>{signed.name}</Text>
          </View>
          <View style={s.certRow}>
            <Text style={s.certKey}>Email</Text>
            <Text style={s.certVal}>{signed.email || "—"}</Text>
          </View>
          <View style={s.certRow}>
            <Text style={s.certKey}>Signed at</Text>
            <Text style={s.certVal}>{signed.date}</Text>
          </View>
          <View style={s.certRow}>
            <Text style={s.certKey}>IP address</Text>
            <Text style={s.certVal}>{signed.ip}</Text>
          </View>
          <View style={s.certRow}>
            <Text style={s.certKey}>Method</Text>
            <Text style={s.certVal}>Electronic signature (typed) · consent captured</Text>
          </View>

          <View style={s.certSeal}>
            <Text style={s.certSealLabel}>TAMPER-EVIDENT SEAL</Text>
            <Text style={s.certSealText}>
              This document was signed electronically in terms of the Electronic Communications and
              Transactions Act 25 of 2002. It carries a PKCS#7 digital signature applied by Denago Cape
              Town; any alteration made after sealing invalidates the signature and is detectable by any
              standard PDF reader.
            </Text>
          </View>
        </Page>
      )}
    </Document>
  );
}
