/**
 * Create a platform administrator — the ONLY way a PlatformAdmin comes into
 * existence. There is deliberately no self-service signup and no "create the first
 * admin" page: such a page is a takeover vector the moment it misfires, so
 * bootstrapping stays on the CLI where it requires database credentials.
 *
 * A PlatformAdmin is NOT a CRM `User` and holds no tenant membership, so this
 * account is independent of every tenant including the founding Denago Cape Town
 * tenant. It signs in at /platform/login, never at the CRM's /login.
 *
 * Usage:
 *   tsx scripts/create-platform-admin.ts --email ops@example.com \
 *     --name "Platform Operator" [--password "<pw>"] --yes
 *
 * Omit --password and a strong one is generated and printed once.
 *
 * SAFETY: writes to DATABASE_URL. A local .env may point at PRODUCTION, so this
 * prints the target host and refuses to write without --yes.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Same floor as the CRM's admin createUser, so the console is not the weak door. */
function validPassword(password: string): boolean {
  return password.length >= 12 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name");
  let password = arg("password");

  if (!email || !name) {
    console.error(
      "Usage: tsx scripts/create-platform-admin.ts --email <email> --name <name> [--password <pw>] --yes",
    );
    process.exit(1);
  }

  if (password && !validPassword(password)) {
    console.error(
      "Password must be at least 12 characters and contain both a letter and a digit.",
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
    console.error(
      "Refusing to write without --yes — confirm the target database above, then re-run with --yes.",
    );
    process.exit(1);
  }

  const generated = !password;
  if (!password) password = crypto.randomBytes(15).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.platformAdmin.findUnique({ where: { email } });
    if (existing) {
      console.error(`A platform admin with email ${email} already exists (${existing.id}).`);
      process.exit(1);
    }

    const admin = await prisma.platformAdmin.create({
      data: { email, name, passwordHash },
    });

    console.log(`Created platform admin ${admin.id} <${email}>.`);
    console.log("Sign in at /platform/login — this account has NO access to the CRM.");
    if (generated) {
      console.log(`Generated password (shown once, not recoverable): ${password}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
