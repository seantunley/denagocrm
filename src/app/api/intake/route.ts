import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateIntakeKey } from "@/lib/apiKeys";
import { establishTenantScopeFromId } from "@/lib/tenantScopeEntry";
import { createIntakeLead } from "@/lib/leadIntake";
import { recordReferral } from "@/lib/referrals";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

const intakeSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  message: z.string().max(5000).optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  color: z.string().max(100).optional().nullable(),
  source: z.string().max(50).optional(),
  referralCode: z.string().max(20).optional().nullable(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/** Website / landing-page lead intake. Authenticate with the X-Api-Key header. */
export async function POST(req: NextRequest) {
  const auth = await authenticateIntakeKey(req.headers.get("x-api-key"), "intake");
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid API key" },
      { status: 401, headers: corsHeaders }
    );
  }
  establishTenantScopeFromId(auth.tenantId);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: corsHeaders }
    );
  }

  const parsed = intakeSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 422, headers: corsHeaders }
    );
  }

  const { referralCode, ...leadInput } = parsed.data;
  const lead = await createIntakeLead({
    ...leadInput,
    source: leadInput.source ?? "website",
    raw: json,
  });
  if (referralCode) await recordReferral(referralCode, lead.id).catch(() => {});

  return NextResponse.json(
    { ok: true, id: lead.id },
    { status: 201, headers: corsHeaders }
  );
}
