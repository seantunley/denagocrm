import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import type { Report, ReportBlock } from "@/lib/assistantReport";

/**
 * A report compiled by the assistant — one of its answers, set out as a document
 * (lib/assistantReport.ts says what a report is and why it cannot hold more than
 * the answer did).
 *
 * Pure Node render (react-pdf), the same approach as the quotation and the stock
 * report, and the same ink-and-accent look so the three read as one family.
 *
 * THE HEADER IS THE BUSINESS'S, on every page: its logo and its name. The logo
 * arrives as PNG bytes already checked and converted (lib/assistantReportLogo.ts)
 * — this component fetches nothing. With no logo the name stands alone, larger.
 */

const ink = "#020617";
const slate700 = "#334155";
const slate500 = "#64748b";
const slate200 = "#e2e8f0";
const slate50 = "#f8fafc";
const white = "#ffffff";
const DEFAULT_ACCENT = "#ea580c";

export type AssistantReportMeta = {
  companyName: string;
  tagline: string;
  /** PNG bytes of the business's logo, or null when it has none we can draw. */
  logo: Buffer | null;
  /** The logo is light lettering on transparency (made for a dark page): drawn on a dark panel. */
  logoOnDark?: boolean;
  /** The workspace's brand colour, when it has set one. */
  accent: string | null;
  assistantName: string;
  preparedFor: string;
  /** When the answer was given — the moment the figures are true for. */
  answeredAt: string;
  generatedAt: string;
  question: string;
};

const s = StyleSheet.create({
  /*
   * NO lineHeight HERE. Set on the page, react-pdf 4.9 stops drawing the fixed
   * footer altogether (found by rendering: the footer's text was simply absent
   * from the file). The default line height reads well at these sizes, so none is set at all.
   */
  page: { paddingTop: 96, paddingBottom: 64, paddingHorizontal: 40, fontSize: 10, fontFamily: "Helvetica", color: slate700 },

  header: { position: "absolute", top: 24, left: 40, right: 40, height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1.5, paddingBottom: 10 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 340 },
  logo: { height: 36, maxWidth: 130, objectFit: "contain" },
  logoPanel: { backgroundColor: ink, borderRadius: 4, paddingVertical: 5, paddingHorizontal: 8 },
  logoOnPanel: { height: 30, maxWidth: 130, objectFit: "contain" },
  brand: { color: ink, fontFamily: "Helvetica-Bold", fontSize: 13, letterSpacing: 0.6 },
  brandLarge: { color: ink, fontFamily: "Helvetica-Bold", fontSize: 17, letterSpacing: 0.8 },
  brandSub: { color: slate500, fontSize: 7, marginTop: 2, letterSpacing: 0.5 },
  docKind: { fontFamily: "Helvetica-Bold", fontSize: 11, letterSpacing: 2.5, textAlign: "right" },
  docDate: { color: slate500, fontSize: 8, textAlign: "right", marginTop: 3 },

  footer: { position: "absolute", bottom: 24, left: 40, right: 40, borderTopWidth: 0.75, borderTopColor: slate200, paddingTop: 7, flexDirection: "row", justifyContent: "space-between" },
  footerText: { width: 430 },
  footerLine: { color: slate500, fontSize: 7, lineHeight: 1.35 },
  pageNo: { color: slate500, fontSize: 7.5 },

  title: { color: ink, fontFamily: "Helvetica-Bold", fontSize: 20, lineHeight: 1.2, marginBottom: 6 },
  meta: { color: slate500, fontSize: 8.5, marginBottom: 14 },
  metaStrong: { color: slate700, fontFamily: "Helvetica-Bold" },

  asked: { backgroundColor: slate50, borderRadius: 4, borderLeftWidth: 3, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 16 },
  askedLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", letterSpacing: 1, color: slate500, marginBottom: 3 },
  askedText: { fontSize: 9.5, color: ink },

  heading: { color: ink, fontFamily: "Helvetica-Bold", fontSize: 12.5, marginTop: 12, marginBottom: 6, paddingBottom: 3, borderBottomWidth: 0.75, borderBottomColor: slate200 },
  paragraph: { marginBottom: 8 },

  list: { marginBottom: 8 },
  item: { flexDirection: "row", marginBottom: 4 },
  bullet: { width: 14, fontFamily: "Helvetica-Bold" },
  itemText: { flex: 1 },

  table: { marginBottom: 10, marginTop: 2 },
  tHead: { flexDirection: "row", backgroundColor: ink, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  tHeadCell: { flex: 1, color: white, fontSize: 7.5, fontFamily: "Helvetica-Bold", letterSpacing: 0.4, paddingVertical: 5, paddingHorizontal: 6 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: slate200 },
  rowAlt: { backgroundColor: slate50 },
  cell: { flex: 1, fontSize: 8.5, paddingVertical: 5, paddingHorizontal: 6, lineHeight: 1.3 },
  cellFirst: { color: ink, fontFamily: "Helvetica-Bold" },

  note: { borderRadius: 4, borderLeftWidth: 3, paddingVertical: 7, paddingHorizontal: 10, marginBottom: 8, backgroundColor: slate50 },
  noteLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 2 },
  noteText: { fontSize: 9.5 },
});

function Block({ block, accent }: { block: ReportBlock; accent: string }) {
  switch (block.kind) {
    case "heading":
      // Kept with what follows: a heading alone at the foot of a page is an orphan.
      return <Text style={s.heading} minPresenceAhead={40}>{block.text}</Text>;
    case "paragraph":
      return <Text style={s.paragraph}>{block.text}</Text>;
    case "list":
      return (
        <View style={s.list}>
          {block.items.map((item, i) => (
            <View key={i} style={s.item} wrap={false}>
              <Text style={[s.bullet, { color: accent }]}>{block.ordered ? `${i + 1}.` : "•"}</Text>
              <Text style={s.itemText}>{item}</Text>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <View style={s.table}>
          {/* Repeats at the top of every page the table runs onto. */}
          <View style={s.tHead} fixed>
            {block.columns.map((column, i) => (
              <Text key={i} style={s.tHeadCell}>{column.toUpperCase()}</Text>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={r % 2 ? [s.row, s.rowAlt] : s.row} wrap={false}>
              {row.map((cell, c) => (
                <Text key={c} style={c === 0 ? [s.cell, s.cellFirst] : s.cell}>{cell}</Text>
              ))}
            </View>
          ))}
        </View>
      );
    case "read":
      // The assistant's own judgement — set apart from the records, and labelled as such.
      return (
        <View style={[s.note, { borderLeftColor: accent }]} wrap={false}>
          <Text style={[s.noteLabel, { color: accent }]}>ASSESSMENT — NOT A RECORD</Text>
          <Text style={s.noteText}>{block.text}</Text>
        </View>
      );
    case "missing":
      return (
        <View style={[s.note, { borderLeftColor: slate500 }]} wrap={false}>
          <Text style={[s.noteLabel, { color: slate500 }]}>NOT IN THE CRM</Text>
          <Text style={s.noteText}>{block.text}</Text>
        </View>
      );
  }
}

export default function AssistantReportDoc({ report, meta }: { report: Report; meta: AssistantReportMeta }) {
  const accent = meta.accent ?? DEFAULT_ACCENT;
  return (
    <Document title={`${report.title} — ${meta.companyName}`} author={meta.companyName} creator={meta.assistantName}>
      <Page size="A4" style={s.page}>
        <View style={[s.header, { borderBottomColor: accent }]} fixed>
          <View style={s.brandRow}>
            {meta.logo && meta.logoOnDark ? (
              <View style={s.logoPanel}>
                {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image is not an HTML img and takes no alt */}
                <Image src={{ data: meta.logo, format: "png" }} style={s.logoOnPanel} />
              </View>
            ) : meta.logo ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image is not an HTML img and takes no alt
              <Image src={{ data: meta.logo, format: "png" }} style={s.logo} />
            ) : null}
            <View>
              <Text style={meta.logo ? s.brand : s.brandLarge}>{meta.companyName}</Text>
              {meta.tagline ? <Text style={s.brandSub}>{meta.tagline.toUpperCase()}</Text> : null}
            </View>
          </View>
          <View>
            <Text style={[s.docKind, { color: accent }]}>REPORT</Text>
            <Text style={s.docDate}>{meta.generatedAt}</Text>
          </View>
        </View>

        <View style={s.footer} fixed>
          <View style={s.footerText}>
            <Text style={s.footerLine}>
              {meta.companyName} — compiled by {meta.assistantName} for {meta.preparedFor} from the CRM records they could see on {meta.answeredAt}.
            </Text>
            <Text style={s.footerLine}>A snapshot: figures may have changed since. Confidential — for internal use.</Text>
          </View>
          <Text style={s.pageNo} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>

        <Text style={s.title}>{report.title}</Text>
        <Text style={s.meta}>
          <Text style={s.metaStrong}>Prepared for </Text>
          {meta.preparedFor}{"   |   "}<Text style={s.metaStrong}>Figures as at </Text>
          {meta.answeredAt}
        </Text>

        {meta.question ? (
          <View style={[s.asked, { borderLeftColor: accent }]}>
            <Text style={s.askedLabel}>WHAT WAS ASKED</Text>
            <Text style={s.askedText}>{meta.question}</Text>
          </View>
        ) : null}

        {report.blocks.map((block, i) => (
          <Block key={i} block={block} accent={accent} />
        ))}
      </Page>
    </Document>
  );
}
