/**
 * Create a new tenant with its first owner. The operator-level provisioning CLI —
 * near-term tenant setup before the platform-admin UI (see MULTITENANCY-SCOPING.md
 * §6). Goes through the shared createTenant() service, so it stays consistent with
 * the future UI and the isolation tests.
 *
 * Usage:
 *   tsx scripts/create-tenant.ts --name "Acme Carts" --slug acme-carts \
 *     --owner-email owner@acme.test --owner-name "Acme Owner" \
 *     [--owner-password "<pw>"] --yes
 *
 * The tenant is created SUSPENDED and the owner is created DISABLED, with no
 * modules and the non-privileged "member" role: there is no tenant data isolation
 * yet, so the credentials must not be able to sign in to the unscoped CRM. Once
 * enforcement lands, a deliberate activation flow enables the tenant AND the user.
 * See MULTITENANCY-SCOPING.md §6.
 *
 * SAFETY: writes to DATABASE_URL. A local .env points at PRODUCTION, so this prints
 * the target host and refuses to write without --yes.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { createTenant } from "../src/lib/provisioning";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const name = arg("name");
  const slug = arg("slug");
  const ownerEmail = arg("owner-email")?.trim().toLowerCase();
  const ownerName = arg("owner-name");
  let password = arg("owner-password");

  if (has("role")) {
    console.error(
      "--role is not supported: User.role is global, so an owner/admin role here would be a cross-tenant superuser. The tenant owner is created as a non-privileged member.",
    );
    process.exit(1);
  }
  if (!name || !slug || !ownerEmail || !ownerName) {
    console.error(
      "Usage: tsx scripts/create-tenant.ts --name <name> --slug <slug> --owner-email <email> --owner-name <name> [--owner-password <pw>] --yes",
    );
    process.exit(1);
  }

  const dbHost = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host || "(no host)";
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();
  console.log(`Target database: ${dbHost}`);
  if (!has("yes")) {
    console.error("Refusing to write without --yes — confirm the target database above, then re-run with --yes.");
    process.exit(1);
  }

  const generated = !password;
  if (!password) password = crypto.randomBytes(15).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);

  const prisma = new PrismaClient();
  try {
    const { tenantId, ownerId } = await createTenant(prisma, {
      name,
      slug,
      owner: { name: ownerName, email: ownerEmail, passwordHash },
    });
    console.log(`Created tenant ${tenantId} ("${name}") — SUSPENDED — with DISABLED member owner ${ownerId} <${ownerEmail}>.`);
    console.log("The owner cannot sign in until isolation ships and a deliberate activation flow enables the tenant and the user.");
    if (generated) console.log(`Generated password for ${ownerEmail} (stored, but login is disabled): ${password}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
