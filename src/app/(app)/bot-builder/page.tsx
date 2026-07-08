import { requireOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { DEFAULT_FLOW, type Flow } from "@/lib/flow";
import FlowBuilder from "@/components/FlowBuilder";

export default async function BotBuilderPage() {
  await requireOwner();
  const raw = await getSetting("BOT_FLOW");
  let flow: Flow = DEFAULT_FLOW;
  if (raw) {
    try {
      const f = JSON.parse(raw);
      if (f?.start && f?.nodes) flow = f;
    } catch {
      /* use default */
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Chatbot flow builder</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Design the WhatsApp conversation — add nodes, drag from a node&apos;s right dot to another
          to connect them, then Save. Turn it on at Settings → WhatsApp Bot → Guided flow.
        </p>
      </div>
      <FlowBuilder initial={flow} />
    </div>
  );
}
