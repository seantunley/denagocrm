import { getActiveTenantId, getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canEditLayout } from "@/lib/docbuilder/layoutAccess";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { parseDocument } from "@/lib/doceditor/model";
import { renderEmailDocument } from "@/lib/doceditor/emailRender";
import { defaultEmailBody, defaultEmailFrame, EMAIL_FRAME_KEY, EMAIL_SAMPLE_FIELDS, emailBodyKey, emailKindOf } from "@/lib/doceditor/emailDefaults";
import { emailBrandFor } from "@/lib/doceditor/emailDocuments";
import { SIGNING_EMAILS } from "@/lib/signing/emailTemplates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The editor's Preview for a customer EMAIL: the DRAFT on screen, rendered
 * exactly as it will send — frame and body together, the workspace's logo,
 * colour and details — with obviously made-up sample details. Sends nothing.
 *
 * The frame previews around the Quote email; a message previews inside the
 * workspace's current frame draft. Owner-only, as editing an email is.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await context.params;
  const template = await getBuilderTemplate(id);
  const kind = template ? emailKindOf(template.key) : null;
  if (!template || (!kind && template.key !== EMAIL_FRAME_KEY)) return new Response("Not found", { status: 404 });
  if (!(await canEditLayout(user, template.key))) return new Response("Not found", { status: 404 });
  // The ACTING workspace, from the session — and the template must be its own
  // (getBuilderTemplate already refused another workspace's email; checked again
  // here so this route never depends on that alone). Everything below — the
  // companion frame/body, the brand — is read for exactly this tenant.
  const tenantId = await getActiveTenantId();
  if (!tenantId || template.tenantId !== tenantId) return new Response("Not found", { status: 404 });

  const draft = parseDocument(template.data);
  if (!draft) return new Response("This email can't be read.", { status: 422 });
  // The other half: for a message, this workspace's frame as it is being designed; for the frame, a sample message.
  const otherKey = kind ? EMAIL_FRAME_KEY : emailBodyKey("quote");
  const other = await prisma.docBuilderTemplate.findFirst({
    where: { tenantId, key: otherKey, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: { data: true },
  });
  const otherDoc = other ? parseDocument(other.data) : null;
  const frame = kind ? (otherDoc ?? defaultEmailFrame()) : draft;
  const body = kind ? draft : (otherDoc ?? defaultEmailBody("quote"));
  const shown = kind ?? "quote";

  const brand = await emailBrandFor(tenantId);
  const fields: Record<string, string> = {};
  for (const f of SIGNING_EMAILS[shown].fields) fields[f] = EMAIL_SAMPLE_FIELDS[f] ?? "";
  Object.assign(fields, { company_name: brand.companyName, company_phone: brand.phone, company_email: brand.email });
  // A message a person sends previews signed by the viewer — their own details, as their sends will be.
  if ((SIGNING_EMAILS[shown].fields as readonly string[]).includes("sender_name")) {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { mobile: true, jobTitle: true } });
    Object.assign(fields, { sender_name: user.name, sender_email: user.email, sender_mobile: me?.mobile ?? "", sender_title: me?.jobTitle ?? "" });
  }
  const email = renderEmailDocument({ frame, body, fields, brand, action: SIGNING_EMAILS[shown].action ?? null });

  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview — ${esc(email.subject)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#e5e7eb}
.bar{position:sticky;top:0;z-index:1;background:#0b0f19;color:#e2e8f0;padding:12px 20px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;font-size:13px}
.bar b{color:#fff;font-size:14px}.bar span{color:#94a3b8}
.tabs{margin-left:auto;display:flex;gap:6px}.tabs label{background:#1e293b;color:#e2e8f0;border-radius:999px;padding:5px 12px;cursor:pointer}
input{position:absolute;opacity:0;pointer-events:none}
#desktop:checked~.bar label[for=desktop],#phone:checked~.bar label[for=phone]{background:#f1603c;color:#fff}
#phone:focus-visible~.bar label[for=phone],#desktop:focus-visible~.bar label[for=desktop]{outline:2px solid #f1603c}
iframe{display:block;border:0;margin:0 auto;width:100%;height:calc(100vh - 48px);background:#f3f4f6;transition:width .2s}
#phone:checked~iframe{width:390px}</style></head>
<body>
<input type="radio" name="width" id="desktop" checked><input type="radio" name="width" id="phone">
<div class="bar"><span>Subject</span><b>${esc(email.subject)}</b><span>Sample details — nothing is sent.</span>
<div class="tabs"><label for="desktop">Desktop</label><label for="phone">Phone</label></div></div>
<iframe title="Email preview" sandbox="allow-same-origin allow-popups" srcdoc="${esc(email.html)}"></iframe>
</body></html>`;
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
