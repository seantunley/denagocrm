import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { disconnectWhatsAppNumber } from "@/app/actions/whatsappConnect";
import { connectedWhatsApp, whatsappSignupApp } from "@/lib/whatsappConnect";
import { PLATFORM_URL } from "@/lib/platformLegal";
import { WhatsAppConnectButton } from "./WhatsAppConnectButton";

/**
 * Settings → Integrations → WhatsApp: CONNECT WHATSAPP (Meta's Embedded Signup on the platform app). Hidden until the
 * platform owner saves the signup configuration id. A number set up by pasting its id and token (Denago's) is left
 * exactly as it is — connecting replaces it only when the owner presses the button.
 */
export default async function WhatsAppConnectBox({ tenantId }: { tenantId: string }) {
  const [app, connected] = await Promise.all([whatsappSignupApp(), connectedWhatsApp(tenantId)]);
  if (!app && !connected) return null;
  return (
    <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
      <p className="text-sm font-medium">{connected ? `Connected: ${connected.name ? `${connected.name} · ` : ""}${connected.number}` : "Connect your WhatsApp number"}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Sign in with Facebook, choose or create your WhatsApp Business account and verify a number by SMS or call. Messages
        to that number then arrive in this workspace only. Meta charges for some WhatsApp messages and bills your own
        WhatsApp account — add a payment method in WhatsApp Manager. A number already on the WhatsApp Business phone app
        has to move to this connection first; it can&apos;t be used in both.
      </p>
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
