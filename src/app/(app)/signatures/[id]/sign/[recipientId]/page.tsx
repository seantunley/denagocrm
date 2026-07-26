import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import { recordView } from "@/lib/signing/events";
import { SignSurface } from "@/app/signing/[token]/SignSurface";

export const dynamic = "force-dynamic";

/** In-person signing: staff opens this on a device and hands it to the recipient. */
export default async function InPersonSign({ params }: { params: Promise<{ id: string; recipientId: string }> }) {
  await requirePermission("signing.manage");
  const { id, recipientId } = await params;
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    include: { request: { include: { fields: true } } },
  });
  if (!recipient || recipient.requestId !== id) notFound();
  const req = recipient.request;

  if (recipient.status === "signed") {
    return <div className="p-6 text-sm text-muted-foreground"><Link href={`/signatures/${id}`} className="text-primary">← Back</Link><p className="mt-4">{recipient.name} has already signed.</p></div>;
  }

  await recordView(recipient.id, req.id, recipient.name);
  const [sheets, stamps] = await Promise.all([renderRequestSigningSheets(req), signedFieldStamps(req.id, recipient.id)]);
  const myFields = req.fields
    .filter((f) => f.recipientId === recipient.id || f.recipientId === null)
    .map((f) => ({ id: f.id, kind: f.kind, label: f.label, required: f.required, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }));

  return (
    <div className="min-h-screen bg-slate-900 p-4">
      <div className="mx-auto mb-3 flex max-w-4xl items-center justify-between">
        <Link href={`/signatures/${id}`} className="text-xs text-slate-400 hover:text-white">← Back to request</Link>
        <span className="text-xs text-slate-500">In-person signing · hand the device to {recipient.name}</span>
      </div>
      <div className="flex justify-center">
        <SignSurface token={recipient.token} title={req.title} recipientName={recipient.name} sheets={sheets} fields={myFields} stamps={stamps} />
      </div>
    </div>
  );
}
