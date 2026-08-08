/**
 * Set up a LOCAL preview of per-tenant branding: two tenants, two hostnames, one
 * dev server.
 *
 * Seeing the branding chain locally is harder than it should be, for one reason
 * that is not obvious until you try: the whole feature keys off the HOSTNAME, and
 * `localhost` matches no TenantDomain row, so a local dev server shows the
 * UNBRANDED fallback and nothing else. You can read every line of the diff and
 * never see the thing working.
 *
 * The console's own "Verify" button cannot help either. Since the domain check
 * became a real probe it fetches `https://<host>/api/brand/domain-check`, and
 * `safeFetchText` refuses any hostname resolving to a private address — which is
 * every local one, deliberately, because "verify this domain" must not be an SSRF
 * primitive. So local rows are written verified here instead, which is a thing a
 * script run by hand against a dev database may do and a server action may not.
 *
 * WHAT THIS WRITES (all additive, all idempotent):
 *   - brand columns on the founding tenant, if they are still null
 *   - a second tenant, "Acme Golf Carts", suspended and inert like any other
 *   - verified TenantDomain rows pointing two hostnames at those two tenants
 *
 * SAFETY: refuses to run against production, and refuses without --yes.
 *
 *   npm run preview:branding -- --yes
 */
import { PrismaClient } from "@prisma/client";

const PROD_HOST_MARKER = "ep-patient-waterfall";

/**
 * Hostnames that reach a local dev server.
 *
 * `*.localhost` — NOT a public wildcard domain like localtest.me, and the
 * difference is the whole reason this note exists.
 *
 * Browsers resolve anything under `.localhost` to loopback themselves, so a
 * second brand needs no hosts file and no DNS. More importantly they treat it as
 * a POTENTIALLY TRUSTWORTHY origin, which `acme.localtest.me` is not — and the
 * app sends `upgrade-insecure-requests`. On an untrusted origin the browser
 * therefore rewrites every http:// subresource to https://, the dev server does
 * not speak TLS, and the page renders with NO STYLESHEET AT ALL.
 *
 * It looks exactly like the branding chain broke the CSS. It is one CSP
 * directive doing precisely its job, and localhost being exempt is why the
 * first hostname never shows it. Verified by screenshotting both.
 */
const HOSTS = {
  founding: "localhost",
  demo: "acme.localhost",
} as const;

const DEMO = {
  id: "tenant_preview_acme",
  name: "Acme Golf Carts",
  slug: "acme-golf-carts",
  displayName: "Acme Golf Carts",
  tagline: "Fleet sales & service",
  primary: "#0d9488",
};

const FOUNDING_ID = "tenant_denago_cpt";

function has(flag: string) {
  return process.argv.includes(`--${flag}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => {
    try {
      return new URL(url).host || "(no host)";
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();

  // The guard that matters. A local .env points at PRODUCTION in this project,
  // and the Prisma CLI reads .env rather than .env.local — so the default for a
  // script like this is the live database, not the dev branch. Refuse by name.
  if (host.includes(PROD_HOST_MARKER)) {
    console.error(
      `\nREFUSED: ${host} is the production database.\n\n` +
        `This script writes tenants and verified domains. Point it at the dev branch:\n` +
        `  DATABASE_URL="<your .env.local DATABASE_URL>" npm run preview:branding -- --yes\n`,
    );
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("REFUSED: NODE_ENV=production.");
    process.exit(1);
  }

  console.log(`Target database: ${host}`);
  if (!has("yes")) {
    console.error("Refusing to write without --yes.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const founding = await prisma.tenant.findUnique({
      where: { id: FOUNDING_ID },
      select: { id: true, name: true },
    });
    if (!founding) {
      console.error(
        `\nNo tenant "${FOUNDING_ID}" in this database.\n` +
          `Apply migrations against it first — see docs/PREVIEWING-BRANDING.\n`,
      );
      process.exit(1);
    }

    // COALESCE, so a brand somebody set by hand in the console is not overwritten
    // by a preview script. Same rule the seed migration follows.
    await prisma.$executeRaw`
      UPDATE "Tenant"
      SET "brandDisplayName" = COALESCE("brandDisplayName", 'Denago Cape Town'),
          "brandTagline"     = COALESCE("brandTagline", 'Authorized Denago EV Dealer')
      WHERE "id" = ${FOUNDING_ID}
    `;

    await prisma.$executeRaw`
      INSERT INTO "Tenant" ("id", "name", "slug", "active", "brandDisplayName", "brandTagline", "brandPrimary")
      VALUES (${DEMO.id}, ${DEMO.name}, ${DEMO.slug}, false, ${DEMO.displayName}, ${DEMO.tagline}, ${DEMO.primary})
      ON CONFLICT ("id") DO UPDATE SET
        "brandDisplayName" = EXCLUDED."brandDisplayName",
        "brandTagline"     = EXCLUDED."brandTagline",
        "brandPrimary"     = EXCLUDED."brandPrimary"
    `;

    // brandForHost requires the tenant to be ACTIVE as well as the domain
    // verified. The demo tenant is created inert like any other, so preview mode
    // activates it explicitly — on a dev database, by hand, which is the only
    // place that is a reasonable thing to do.
    await prisma.$executeRaw`UPDATE "Tenant" SET "active" = true WHERE "id" = ${DEMO.id}`;

    for (const [tenantId, hostname] of [
      [FOUNDING_ID, HOSTS.founding],
      [DEMO.id, HOSTS.demo],
    ] as const) {
      await prisma.$executeRaw`
        INSERT INTO "TenantDomain" ("id", "tenantId", "hostname", "verifiedAt")
        VALUES (${`tdom_preview_${hostname.replace(/[^a-z0-9]/g, "_")}`}, ${tenantId}, ${hostname}, NOW())
        ON CONFLICT ("hostname") DO UPDATE SET
          "tenantId"   = EXCLUDED."tenantId",
          "verifiedAt" = NOW()
      `;
    }

    console.log(
      `\nReady. Start the dev server, then compare:\n\n` +
        `  http://${HOSTS.founding}:3000/login          → ${founding.name}\n` +
        `  http://${HOSTS.demo}:3000/login   → ${DEMO.name} (teal)\n\n` +
        `Same server, same deployment, two brands — which is the whole claim.\n` +
        `An unknown host still shows the neutral platform shell; try 127.0.0.1:3000.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
