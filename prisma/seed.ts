import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const prisma = new PrismaClient();

async function main() {
  // Initial owner — credentials come from the environment, never hardcoded.
  //  - production: refuses to run without INITIAL_ADMIN_EMAIL + a >=14-char password
  //  - preview deployments: never create a privileged owner
  //  - local/dev with an email but no password: a random one-time password is printed
  // Existing users' passwords are never overwritten.
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL?.trim();
  const adminName = process.env.INITIAL_ADMIN_NAME?.trim() || "Administrator";
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
  const vercelEnv = process.env.VERCEL_ENV; // production | preview | development | undefined
  const isProduction = vercelEnv === "production" || process.env.NODE_ENV === "production";

  // Tenant foundation: every provisioned user MUST have a tenant membership —
  // tenant access is fail-closed, so a membership-less user gets NO tenant context
  // (never a silent default). The migration backfills EXISTING users; users seeded
  // AFTER it (this owner, CI) get their membership here. Idempotent.
  const ensureFoundingMembership = async (userId: string) => {
    await prisma.tenant.upsert({
      where: { id: DEFAULT_TENANT_ID },
      update: {},
      create: { id: DEFAULT_TENANT_ID, name: "Denago Cape Town", slug: "denago-cape-town", active: true },
    });
    await prisma.tenantMember.upsert({
      where: { tenantId_userId: { tenantId: DEFAULT_TENANT_ID, userId } },
      update: {},
      create: { tenantId: DEFAULT_TENANT_ID, userId },
    });
  };

  const upsertOwner = async (email: string, name: string, passwordHash: string) => {
    const user = await prisma.user.upsert({
      where: { email },
      update: { role: "owner" }, // never overwrite an existing user's password
      create: { name, email, passwordHash, role: "owner" },
    });
    await ensureFoundingMembership(user.id);
  };

  if (vercelEnv === "preview") {
    console.log("Seed: preview deployment — not creating an owner account.");
  } else if (adminEmail && adminPassword) {
    if (adminPassword.length < 14) {
      throw new Error("INITIAL_ADMIN_PASSWORD must be at least 14 characters.");
    }
    await upsertOwner(adminEmail, adminName, await bcrypt.hash(adminPassword, 10));
    console.log(`Seed: ensured owner ${adminEmail}.`);
  } else if (isProduction) {
    throw new Error(
      "Refusing to seed an owner in production: set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD (>= 14 chars).",
    );
  } else if (adminEmail) {
    const generated = crypto.randomBytes(18).toString("base64url");
    await upsertOwner(adminEmail, adminName, await bcrypt.hash(generated, 10));
    console.log(
      `Seed: created dev owner ${adminEmail} with a random password:\n    ${generated}\n` +
        "(set INITIAL_ADMIN_PASSWORD to choose your own; existing passwords are never overwritten)",
    );
  } else {
    console.log("Seed: no INITIAL_ADMIN_EMAIL set — skipping owner creation.");
  }

  // Pipeline stages. NOTE: migration 52 added the required PipelineStage.pipelineId
  // (and a default "pipeline_default_retail" pipeline) but schema.prisma has not
  // been reconciled with it, so the generated client omits the column. Insert via
  // raw SQL against the real columns until the schema is synced.
  const stages = [
    { name: "New", order: 0, color: "#3b82f6" },
    { name: "Contacted", order: 1, color: "#8b5cf6" },
    { name: "Qualified", order: 2, color: "#f59e0b" },
    { name: "Test Ride", order: 3, color: "#06b6d4" },
    { name: "Quoted", order: 4, color: "#10b981" },
  ];
  const existing = await prisma.pipelineStage.count();
  if (existing === 0) {
    for (const s of stages) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PipelineStage" ("id","name","order","color","pipelineId") VALUES ($1,$2,$3,$4,'pipeline_default_retail')`,
        crypto.randomUUID(),
        s.name,
        s.order,
        s.color
      );
    }
  }

  // Integration settings (placeholders — fill in via Settings page)
  const settings: Record<string, string> = {
    META_VERIFY_TOKEN: crypto.randomBytes(16).toString("hex"),
    META_PAGE_ACCESS_TOKEN: "",
    INTAKE_API_KEY: crypto.randomBytes(24).toString("hex"),
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.appSetting.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
  }

  // Denago Cape Town vehicle range (see scripts/import-products.ts for re-import)
  const productCount = await prisma.product.count();
  if (productCount === 0) {
    const products = [
      { name: "Denago EV City Cart", sku: "city-cart", basePriceCents: 35_000_000, description: "5 seats · 100 km range · From R350,000 incl. VAT", colors: [] as string[] },
      { name: "Denago EV Scout 2", sku: "scout-2", basePriceCents: 16_000_000, description: "2 seats · 64 km range · From R160,000 incl. VAT", colors: [] as string[] },
      { name: "Denago EV Scout 4", sku: "scout-4", basePriceCents: 17_000_000, description: "4 seats · 64 km range · From R170,000 incl. VAT", colors: [] as string[] },
      { name: "Denago EV Nomad", sku: "nomad", basePriceCents: 0, description: "4 seats (2+2, non-lifted) · 64 km range · Pricing on enquiry", colors: ["Champagne", "Gray", "White", "Black", "Blue", "Lava"] },
      { name: "Denago EV Nomad XL", sku: "nomad-xl", basePriceCents: 22_000_000, description: "4 seats (2+2, lifted) · 64 km range · From R220,000 incl. VAT", colors: ["Champagne", "Gray", "White", "Black", "Blue", "Lava"] },
      { name: "Denago EV Rover XL", sku: "rover-xl", basePriceCents: 23_500_000, description: "4 seats forward-facing (lifted) · 64 km range · From R235,000 incl. VAT · Most popular", colors: ["Gray", "Lava", "White", "Black", "Blue", "Verdant"] },
      { name: "Denago EV Rover XL 6", sku: "rover-xl-6", basePriceCents: 27_000_000, description: "6 seats (4+2, lifted) · 52 km range · From R270,000 incl. VAT", colors: ["Gray", "Lava", "White", "Black", "Blue", "Verdant"] },
      { name: "Denago EV Rover XXL", sku: "rover-xxl", basePriceCents: 27_000_000, description: "6 seats forward-facing (lifted) · 52 km range · From R270,000 incl. VAT", colors: ["Gray", "Scarlet", "White", "Black", "Blue", "Verdant", "Lava"] },
    ];
    for (const p of products) {
      await prisma.product.create({
        data: {
          name: p.name,
          sku: p.sku,
          category: "Electric utility vehicle",
          basePriceCents: p.basePriceCents,
          description: p.description,
          colors: { create: p.colors.map((name) => ({ name })) },
        },
      });
    }
  }

  // Starter email template + automation rules
  if ((await prisma.emailTemplate.count()) === 0) {
    await prisma.emailTemplate.create({
      data: {
        name: "New enquiry welcome",
        subject: "Your {{model}} enquiry — Denago Cape Town",
        body: "Hi {{first_name}},\n\nThank you for your interest in the {{model}}{{color}} — great choice.\n\nI'd love to arrange a demonstration drive at your property or at our Maitland showroom. When would suit you this week?\n\nWarm regards,\n{{user_name}}\nDenago Cape Town\n081 515 8319 · denagocpt.co.za",
      },
    });
  }
  if ((await prisma.automationRule.count()) === 0) {
    await prisma.automationRule.create({
      data: {
        name: "Call every new lead within a day",
        trigger: "lead_created",
        action: "create_activity",
        activityType: "call",
        activitySummary: "Call this new lead — introduce yourself and book a demo",
        activityDueDays: 1,
      },
    });
    await prisma.automationRule.create({
      data: {
        name: "Nudge when a lead goes quiet for 4 days",
        trigger: "lead_idle",
        idleDays: 4,
        action: "create_activity",
        activityType: "whatsapp",
        activitySummary: "Lead has gone quiet — send a WhatsApp check-in",
        activityDueDays: 0,
      },
    });
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
