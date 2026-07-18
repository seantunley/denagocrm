import type { Metadata } from "next";
import TelegramLauncher from "./TelegramLauncher";

export const metadata: Metadata = {
  title: "Denago CRM",
  robots: { index: false, follow: false },
};

// Public launcher: Telegram opens this inside its webview, we verify the signed
// initData server-side and drop the user into the CRM. No session required to
// reach it — establishing the session is the whole point.
export default function TelegramEntryPage() {
  return <TelegramLauncher />;
}
