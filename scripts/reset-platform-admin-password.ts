/**
 * Give a platform administrator a NEW password — the recovery for a lost one (Sean, 2026-11-02: "I do not have that
 * password"). Like create-platform-admin.ts this stays on the CLI, where it needs database credentials: the console
 * has nobody above it, so a reset page would be a takeover door.
 *
 * Usage:
 *   tsx scripts/reset-platform-admin-password.ts --email ops@example.com --yes
 *
 * A strong password is generated and printed ONCE, here in your own terminal, and stored only as a bcrypt hash.
 * Every existing console session is signed out (sessionVersion bumped). Two-factor, if enrolled, is left as it is.
 *
 * SAFETY: writes to DATABASE_URL. A local .env may point at PRODUCTION, so this prints the target host and the
 * account, and refuses to write without --yes.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: tsx scripts/reset-platform-admin-password.ts --email <email> --yes");
    process.exit(1);
  }
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host || "(no host)";
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();
  console.log(`Target database: ${host}`);

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.platformAdmin.findUnique({ where: { email }, select: { id: true, name: true, disabledAt: true } });
    if (!admin) {
      console.error(`No platform admin with email ${email}.`);
      process.exit(1);
    }
    console.log(`Account: ${admin.name} <${email}>${admin.disabledAt ? " — DISABLED (a new password will not let it in)" : ""}`);
    if (!process.argv.includes("--yes")) {
      console.error("Refusing to write without --yes — confirm the database and account above, then re-run with --yes.");
      process.exit(1);
    }

    const password = crypto.randomBytes(15).toString("base64url");
    await prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { passwordHash: await bcrypt.hash(password, 12), passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
    });
    console.log("Password reset; every existing console session is signed out.");
    console.log(`New password (shown once, not recoverable): ${password}`);
    console.log("Sign in at /platform/login.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
