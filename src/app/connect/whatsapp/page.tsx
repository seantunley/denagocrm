import type { Metadata } from "next";
import { PLATFORM } from "@/lib/platformLegal";
import { whatsappSignupApp, whatsappSignupOrigin } from "@/lib/whatsappConnect";
import { WA_SIGNUP_GRAPH_VERSION } from "@/lib/whatsappSignupMessage";
import { WhatsAppSignupPopup } from "./WhatsAppSignupPopup";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `Connect WhatsApp — ${PLATFORM.name}`, robots: { index: false } };

/**
 * The Connect WhatsApp popup, on the platform's own address — the one domain listed in the Meta app, the only place
 * Meta's Embedded Signup returns its result to (lib/whatsappConnect.ts). No session here: the one-time state says which
 * Settings page started it, and the result is handed back to exactly that origin. Nothing is connected on this page.
 */
export default async function ConnectWhatsAppPage({ searchParams }: { searchParams?: Promise<{ state?: string }> }) {
  const state = String((await searchParams)?.state ?? "");
  const [returnOrigin, app] = await Promise.all([whatsappSignupOrigin(state), whatsappSignupApp()]);
  return (
    <div className="min-h-screen bg-white px-6 py-10 text-slate-800">
      <p className="text-sm font-semibold tracking-wide text-amber-600">{PLATFORM.name}</p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Connect WhatsApp</h1>
      {returnOrigin && app ? (
        <WhatsAppSignupPopup appId={app.appId} configId={app.configId} version={WA_SIGNUP_GRAPH_VERSION} state={state} returnOrigin={returnOrigin} />
      ) : (
        <p className="mt-4 text-sm">This link has expired or isn&apos;t valid. Close this window and press Connect WhatsApp again in Settings.</p>
      )}
    </div>
  );
}
