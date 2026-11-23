import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { disconnectWhatsAppNumber } from "@/app/actions/whatsappConnect";
import { connectedWhatsApp, savedRegistrationPin, whatsappSignupApp } from "@/lib/whatsappConnect";
import { PLATFORM_URL } from "@/lib/platformLegal";
import { pendingWhatsAppUnsubscribes } from "@/lib/whatsappUnsubscribe";
import { WhatsAppConnectButton } from "./WhatsAppConnectButton";

/**
 * Settings → Integrations → WhatsApp: CONNECT WHATSAPP (Meta's Embedded Signup on the platform app). Hidden until the
 * platform owner saves the signup configuration id. A number set up by pasting its id and token (Denago's) is left
 * exactly as it is — connecting replaces it only when the owner presses the button.
 */
export default async function WhatsAppConnectBox({ tenantId }: { tenantId: string }) {
  const [app, connected, waiting] = await Promise.all([whatsappSignupApp(), connectedWhatsApp(tenantId), pendingWhatsAppUnsubscribes(tenantId)]);
  if (!app && !connected && !waiting.length) return null;
  const pin = connected?.phoneNumberId ? await savedRegistrationPin(tenantId, connected.phoneNumberId) : null;
  return (
    <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
      <p className="text-sm font-medium">{connected ? `Connected: ${connected.name ? `${connected.name} · ` : ""}${connected.number}` : "Connect your WhatsApp number"}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Sign in with Facebook, choose or create your WhatsApp Business account and verify a number by SMS or call. Messages
        to that number then arrive in this workspace only. Meta charges for some WhatsApp messages and bills your own
        WhatsApp account — add a payment method in WhatsApp Manager. A number already on the WhatsApp Business phone app
        has to move to this connection first; it can&apos;t be used in both.
      </p>
      {pin && (
        <p className="mt-2 text-xs text-muted-foreground">
          Two-step verification PIN for this number: <span className="font-mono text-foreground">{pin}</span>. Keep it — Meta
          asks for it if the number is ever moved to another provider.
        </p>
      )}
      {waiting.map((item) => (
        <p key={item.since} className="mt-2 text-xs text-amber-600">
          Still asking Meta to stop sending messages from a WhatsApp Business account you no longer use here (since{" "}
          {new Date(item.since).toLocaleDateString("en-ZA", { day: "numeric", month: "long" })}). We try again every 6 hours;
          you can also remove the app from that account in Meta Business settings.
        </p>
      ))}
      <div className="mt-3 flex flex-wrap items-start gap-2">
        {app && <WhatsAppConnectButton platformOrigin={PLATFORM_URL} label={connected ? "Connect a different number" : "Connect WhatsApp"} />}
        {connected && (
          <ConfirmActionDialog
            trigger={<button type="button" className="btn-secondary btn-sm">Disconnect</button>}
            title="Disconnect this WhatsApp number?"
            description="Messages to this number stop arriving here. The number stays yours and stays registered with Meta; conversations already in the CRM stay."
            confirmLabel="Disconnect"
            onConfirm={disconnectWhatsAppNumber}
            destructive
            success="Disconnected"
          />
        )}
      </div>
    </div>
  );
}
