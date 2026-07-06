import { enableSigning, emailSigningLink } from "@/app/actions/signing";
import CopyButton from "@/components/CopyButton";
import { formatDateTime } from "@/lib/format";

const BASE = "https://crm.denagocpt.co.za";

/** "Send for signature" card on quote / job card pages. */
export default function SigningBlock({
  kind,
  id,
  refLabel,
  signToken,
  signedAt,
  signedByName,
  customerEmail,
  customerPhone,
}: {
  kind: "quote" | "jobcard";
  id: string;
  refLabel: string;
  signToken: string | null;
  signedAt: Date | null;
  signedByName: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
}) {
  if (signedAt) {
    return (
      <div className="card bg-emerald-500/10 border-emerald-500/30">
        <p className="text-sm text-emerald-300">
          ✍ Signed online by <b>{signedByName}</b> on {formatDateTime(signedAt)}. The signed PDF
          is filed in the customer&apos;s documents.
        </p>
      </div>
    );
  }

  const link = signToken ? `${BASE}/sign/${kind}/${signToken}` : null;
  const waDigits = (customerPhone ?? "").replace(/\D/g, "").replace(/^0/, "27");

  return (
    <div className="card">
      <h2 className="font-semibold mb-1">✍ Online signature</h2>
      <p className="text-xs text-slate-400 mb-4">
        The customer opens a secure link, reviews {refLabel}, and signs on their phone —
        {kind === "quote" ? " signing accepts the quote and wins the lead automatically." : " no printing needed."}
      </p>
      {!link ? (
        <form action={enableSigning.bind(null, kind, id)}>
          <button className="btn-primary">Create signing link</button>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input readOnly value={link} className="input text-xs font-mono" />
            <CopyButton text={link} />
          </div>
          <div className="flex gap-2 flex-wrap">
            {customerEmail && (
              <form action={emailSigningLink.bind(null, kind, id)}>
                <button className="btn-secondary btn-sm">✉️ Email link to {customerEmail}</button>
              </form>
            )}
            {waDigits.length >= 10 && (
              <a
                href={`https://wa.me/${waDigits}?text=${encodeURIComponent(
                  `Hi! Here's your Denago Cape Town ${kind === "quote" ? "quote" : "job card"} ${refLabel} to review and sign online: ${link}`
                )}`}
                target="_blank"
                className="btn-secondary btn-sm"
              >
                💬 Send via WhatsApp
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
