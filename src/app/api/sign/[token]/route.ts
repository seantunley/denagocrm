import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { saveFile } from "@/lib/storage";
import { buildSignedPdf } from "@/lib/signedPdf";
import { renderUrlToPdf } from "@/lib/htmlPdf";
import { sendEmail } from "@/lib/email";
import { contactName, formatZAR } from "@/lib/format";
import { quoteExpired } from "@/lib/quoteExpiry";

export const maxDuration = 60; // PDF rendering can take a few seconds

const BASE = "https://crm.denagocpt.co.za";

const signSchema = z.object({
  kind: z.enum(["quote", "jobcard"]),
  name: z.string().min(2).max(120),
  signature: z
    .string()
    .startsWith("data:image/png;base64,")
    .max(400_000), // ~300KB signature PNG
});

/** Customer signs a quote/job card via their secure link. Token IS the auth. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48,64}$/.test(token)) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = signSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please provide your name and signature." }, { status: 422 });
  }
  const { kind, name, signature } = parsed.data;
  const signerIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const signerUserAgent = (req.headers.get("user-agent") ?? "unknown").slice(0, 500);
  const signaturePng = Buffer.from(signature.split(",")[1], "base64");
  const signedAt = new Date();

  if (kind === "quote") {
    const quote = await prisma.quote.findFirst({
      where: { signToken: token },
      include: { items: true, contact: true, lead: { include: { product: true } } },
    });
    if (!quote) return NextResponse.json({ error: "Link not found or expired" }, { status: 404 });
    if (quote.signedAt) {
      return NextResponse.json({ error: "This quote has already been signed." }, { status: 409 });
    }
    if (quoteExpired(quote.validUntil)) {
      return NextResponse.json(
        { error: "This quote has expired. Please contact us for an updated quote." },
        { status: 410 }
      );
    }

    const sigRef = await saveFile(signaturePng, `signature-Q${quote.number}.png`, "image/png");

    const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    // Record the signature FIRST so the print page renders with it embedded.
    // Conditional on signedAt still being null — two simultaneous submissions
    // can't both win.
    const claimed = await basePrisma.quote.updateMany({
      where: { id: quote.id, signedAt: null },
      data: {
        signedAt,
        signedByName: name,
        signatureRef: sigRef,
        signerIp,
        signerUserAgent,
        declinedAt: null,
        declineReason: null,
        status: "accepted",
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "This quote has already been signed." }, { status: 409 });
    }
    if (quote.leadId && quote.lead?.status === "open") {
      await prisma.lead.update({ where: { id: quote.leadId }, data: { status: "won" } });
    }

    // True-to-design PDF from the actual print page; pdf-lib as fallback
    const pdf =
      (await renderUrlToPdf(`${BASE}/sign/quote/${token}/print`)) ??
      (await buildSignedPdf({
        kind: "quote",
        refNumber: `Q-${quote.number}`,
        customerName: quote.contact ? contactName(quote.contact) : quote.lead?.name ?? name,
        customerEmail: quote.contact?.email ?? quote.lead?.email,
        customerPhone: quote.contact?.phone ?? quote.lead?.phone,
        vehicleLine: quote.lead?.product
          ? `${quote.lead.product.name}${quote.lead.color ? ` — ${quote.lead.color}` : ""}`
          : null,
        items: quote.items,
        termsLines: (quote.terms ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        signedByName: name,
        signedAt,
        signerIp,
        signaturePng,
      }));
    const pdfRef = await saveFile(pdf, `Quote-Q${quote.number}-signed.pdf`, "application/pdf");
    const pdfHash = crypto.createHash("sha256").update(pdf).digest("hex");
    await basePrisma.quote.update({ where: { id: quote.id }, data: { signedPdfHash: pdfHash } });
    if (quote.contactId && firstUser) {
      await prisma.document.create({
        data: {
          fileName: `Quote-Q${quote.number}-signed.pdf`,
          storedName: pdfRef,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          contactId: quote.contactId,
          uploadedById: firstUser.id,
        },
      });
    }
    const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
    await logAudit({
      action: "quote.signed",
      summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) signed online by ${name} — signed PDF filed (SHA-256 ${pdfHash.slice(0, 16)}…)`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      userName: name,
    });
    // Confirmation email with the signed PDF attached (best effort)
    const confirmTo = quote.contact?.email ?? quote.lead?.email;
    if (confirmTo) {
      await sendEmail({
        to: confirmTo,
        subject: `Signed copy of your Denago Cape Town quote Q-${quote.number}`,
        text: `Hi ${name.split(/\s+/)[0]},\n\nThank you — quote Q-${quote.number} (${formatZAR(Math.round(total))}) has been signed and accepted. Your signed copy is attached for your records.\n\nWe'll be in touch shortly to arrange the next steps.\n\nWarm regards,\nDenago Cape Town\n081 515 8319`,
        attachments: [
          {
            filename: `Quote-Q${quote.number}-signed.pdf`,
            content: pdf,
            contentType: "application/pdf",
          },
        ],
      }).catch(() => {});
    }
    await sendPushToAll({
      title: "Quote signed 🎉",
      body: `Q-${quote.number} — ${name} · ${formatZAR(Math.round(total))}`,
      url: `/quotes/${quote.id}`,
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  // job card
  const jobCard = await prisma.jobCard.findFirst({
    where: { signToken: token },
    include: { items: true, contact: true, vehicle: true },
  });
  if (!jobCard) return NextResponse.json({ error: "Link not found or expired" }, { status: 404 });
  if (jobCard.signedAt) {
    return NextResponse.json({ error: "This job card has already been signed." }, { status: 409 });
  }

  const sigRef = await saveFile(signaturePng, `signature-JC${jobCard.number}.png`, "image/png");
  const jcClaimed = await basePrisma.jobCard.updateMany({
    where: { id: jobCard.id, signedAt: null },
    data: { signedAt, signedByName: name, signatureRef: sigRef, signerIp, signerUserAgent },
  });
  if (jcClaimed.count === 0) {
    return NextResponse.json({ error: "This job card has already been signed." }, { status: 409 });
  }
  const pdf = await buildSignedPdf({
    kind: "jobcard",
    refNumber: `#${jobCard.number}`,
    customerName: contactName(jobCard.contact),
    customerEmail: jobCard.contact.email,
    customerPhone: jobCard.contact.phone,
    vehicleLine: `${jobCard.vehicle.model}${jobCard.vehicle.vin ? ` · VIN ${jobCard.vehicle.vin}` : ""}`,
    description: jobCard.description,
    items: jobCard.items,
    termsLines: [],
    signedByName: name,
    signedAt,
    signerIp,
    signaturePng,
  });
  const pdfRef = await saveFile(pdf, `JobCard-${jobCard.number}-signed.pdf`, "application/pdf");

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  await basePrisma.jobCard.update({
    where: { id: jobCard.id },
    data: { signedAt, signedByName: name, signatureRef: sigRef, signerIp },
  });
  if (firstUser) {
    await prisma.document.create({
      data: {
        fileName: `JobCard-${jobCard.number}-signed.pdf`,
        storedName: pdfRef,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        contactId: jobCard.contactId,
        jobCardId: jobCard.id,
        uploadedById: firstUser.id,
      },
    });
  }
  await logAudit({
    action: "jobcard.signed",
    summary: `Job card #${jobCard.number} signed online by ${name} — signed PDF filed`,
    contactId: jobCard.contactId,
    userName: name,
  });
  await sendPushToAll({
    title: "Job card signed ✍",
    body: `#${jobCard.number} — ${name}`,
    url: `/jobcards/${jobCard.id}`,
  }).catch(() => {});
  return NextResponse.json({ ok: true });
}
