import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

/**
 * Printable setup guide for wiring the CRM up as a Telegram Mini App. Rendered
 * on demand (react-pdf, pure Node) so the bot username and URLs are always
 * current — no stale committed binary.
 */

const ink = "#020617";
const accent = "#ea580c";
const slate700 = "#334155";
const slate500 = "#64748b";
const slate200 = "#e2e8f0";
const slate50 = "#f8fafc";
const white = "#ffffff";

const s = StyleSheet.create({
  page: { paddingTop: 84, paddingBottom: 56, paddingHorizontal: 44, fontSize: 10, fontFamily: "Helvetica", color: slate700, lineHeight: 1.5 },
  header: { position: "absolute", top: 0, left: 44, right: 44, marginTop: 24, height: 44, backgroundColor: ink, borderRadius: 5, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  brand: { color: white, fontFamily: "Helvetica-Bold", fontSize: 12, letterSpacing: 1 },
  brandSub: { color: "#94a3b8", fontSize: 6.5, marginTop: 2, letterSpacing: 0.5 },
  docTitle: { color: white, fontFamily: "Helvetica-Bold", fontSize: 12, letterSpacing: 2, textAlign: "right" },
  footer: { position: "absolute", bottom: 24, left: 44, right: 44, borderTopWidth: 1.2, borderTopColor: accent, paddingTop: 6, flexDirection: "row", justifyContent: "space-between" },
  footerLine: { color: slate500, fontSize: 7.5 },
  pageNo: { color: slate500, fontSize: 7.5 },

  h1: { fontSize: 18, fontFamily: "Helvetica-Bold", color: ink, marginBottom: 4 },
  lead: { fontSize: 10, color: slate500, marginBottom: 18 },

  sectionLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 1.2, color: accent, marginBottom: 8, marginTop: 6 },

  step: { flexDirection: "row", marginBottom: 12 },
  num: { width: 22, height: 22, borderRadius: 11, backgroundColor: ink, color: white, fontSize: 10, fontFamily: "Helvetica-Bold", textAlign: "center", paddingTop: 4, marginRight: 12 },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: ink, marginBottom: 2 },
  stepText: { fontSize: 9.5, color: slate700 },
  mono: { fontFamily: "Courier", fontSize: 9, color: ink },

  callout: { backgroundColor: slate50, borderLeftWidth: 3, borderLeftColor: accent, borderRadius: 4, padding: 12, marginTop: 8, marginBottom: 8 },
  calloutLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 1, color: accent, marginBottom: 5 },
  calloutText: { fontSize: 9.5, color: slate700 },

  linkRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: slate200, paddingVertical: 6 },
  linkKey: { width: 120, fontSize: 9, fontFamily: "Helvetica-Bold", color: slate700 },
  linkVal: { flex: 1, fontFamily: "Courier", fontSize: 9, color: ink },
});

function Brand({ title }: { title: string }) {
  return (
    <>
      <View style={s.header} fixed>
        <View>
          <Text style={s.brand}>DENAGO CAPE TOWN</Text>
          <Text style={s.brandSub}>CRM · INTERNAL SETUP GUIDE</Text>
        </View>
        <Text style={s.docTitle}>{title}</Text>
      </View>
      <View style={s.footer} fixed>
        <Text style={s.footerLine}>Denago CRM — Telegram Mini App setup · keep internal</Text>
        <Text style={s.pageNo} render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
      </View>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <View style={s.step} wrap={false}>
      <Text style={s.num}>{n}</Text>
      <View style={s.stepBody}>
        <Text style={s.stepTitle}>{title}</Text>
        <Text style={s.stepText}>{children}</Text>
      </View>
    </View>
  );
}

export default function TelegramSetupDoc({ botUsername, baseUrl }: { botUsername: string | null; baseUrl: string }) {
  const bot = botUsername ? `@${botUsername}` : "your bot";
  const botLink = `https://t.me/${botUsername ?? "<yourbot>"}/crm`;
  const webAppUrl = `${baseUrl}/tg`;

  return (
    <Document title="Telegram Mini App — Setup Guide" author="Denago Cape Town">
      <Page size="A4" style={s.page}>
        <Brand title="TELEGRAM MINI APP" />

        <Text style={s.h1}>Launch the CRM as an app in Telegram</Text>
        <Text style={s.lead}>
          Staff open a link and land in the CRM full-screen inside Telegram — signed in, with no password to type on
          their phone. This is a one-time setup done by the owner in Telegram’s BotFather. Takes about five minutes.
        </Text>

        <Text style={s.sectionLabel}>ONE-TIME SETUP — IN BOTFATHER</Text>

        <Step n={1} title="Open BotFather">
          In Telegram, search for <Text style={s.mono}>@BotFather</Text> and open the chat. This is Telegram’s official
          tool for configuring bots. Your CRM already uses {bot}.
        </Step>
        <Step n={2} title="Create the Mini App">
          Send <Text style={s.mono}>/newapp</Text> and select {bot} when prompted.
        </Step>
        <Step n={3} title="Set the Web App URL">
          When asked for the Web App URL, paste: {"\n"}
          <Text style={s.mono}>{webAppUrl}</Text>
          {"\n"}This is the launcher page that verifies the Telegram sign-in and opens the CRM.
        </Step>
        <Step n={4} title="Give it a short name">
          Use <Text style={s.mono}>crm</Text> (you’ll also add a title, description and an icon when BotFather asks).
          BotFather then returns your Mini App link — the one staff will use:
        </Step>

        <View style={s.callout}>
          <Text style={s.calloutLabel}>YOUR MINI APP LINK</Text>
          <Text style={[s.calloutText, s.mono]}>{botLink}</Text>
          <Text style={[s.calloutText, { marginTop: 4 }]}>
            Share this with staff, pin it, or add it to a group. Tapping it opens the CRM as an app.
          </Text>
        </View>

        <Step n={5} title="Optional — add a permanent Open button">
          In BotFather choose <Text style={s.mono}>/mybots</Text> → {bot} → <Text style={s.mono}>Bot Settings</Text> →{" "}
          <Text style={s.mono}>Menu Button</Text>, and set the URL to the same{" "}
          <Text style={s.mono}>{webAppUrl}</Text>. The bot chat then shows a permanent “Open” button.
        </Step>

        <Text style={s.sectionLabel}>FOR EACH STAFF MEMBER — LINK ONCE</Text>
        <Step n={1} title="Generate a code on the computer">
          In the CRM (in a browser, already signed in), open <Text style={s.mono}>Settings → Telegram</Text> and tap{" "}
          <Text style={s.mono}>Generate link code</Text>.
        </Step>
        <Step n={2} title="Enter it in the Mini App">
          Open the Mini App link above in Telegram, type the code, and tap <Text style={s.mono}>Link &amp; sign in</Text>.
          From then on the app signs that person in automatically.
        </Step>

        <View style={s.callout}>
          <Text style={s.calloutLabel}>GOOD TO KNOW</Text>
          <Text style={s.calloutText}>
            • Works in the Telegram mobile and desktop apps. {"\n"}
            • No password is ever entered inside Telegram — linking reuses the sign-in already done on web (including
            two-factor). {"\n"}
            • To revoke a phone, unlink it in Settings → Telegram, or sign the device out in Settings → Sessions.
          </Text>
        </View>

        <Text style={s.sectionLabel}>REFERENCE</Text>
        <View style={s.linkRow}>
          <Text style={s.linkKey}>Web App URL</Text>
          <Text style={s.linkVal}>{webAppUrl}</Text>
        </View>
        <View style={s.linkRow}>
          <Text style={s.linkKey}>Mini App link</Text>
          <Text style={s.linkVal}>{botLink}</Text>
        </View>
        <View style={s.linkRow}>
          <Text style={s.linkKey}>Bot</Text>
          <Text style={s.linkVal}>{botUsername ? `@${botUsername}` : "set TELEGRAM_BOT_TOKEN in Settings → Integrations"}</Text>
        </View>
      </Page>
    </Document>
  );
}
