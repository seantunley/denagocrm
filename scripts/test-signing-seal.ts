/**
 * ONE SEALING CERTIFICATE PER WORKSPACE — made once, stored encrypted, and never
 * swapped for a temporary one without saying so.
 *
 * What makes this a database test: "made once" is a claim about two completions
 * arriving together on a workspace's first signature, and it is settled by a
 * unique index, not by anything the code can be read to promise. The same goes
 * for "stored encrypted" (what is actually in the row) and for the fallback
 * (what lands in the error log when the row cannot be opened).
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * the workspace and settings it creates.
 */
import { basePrisma } from "../src/lib/db";
import { sealCertificateInfo } from "../src/lib/pdf/seal";
import {
  SEAL_IDENTITY_KEY,
  __resetSealIdentityCache,
  configuredSealIdentity,
  ensureWorkspaceSealIdentity,
  sealIdentityFor,
  storedSealIdentity,
} from "../src/lib/signing/sealIdentity";

const SFX = Math.random().toString(16).slice(2, 10);
const tenantA = `t_seal_a_${SFX}`;
const tenantB = `t_seal_b_${SFX}`;
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const fingerprint = (material: Parameters<typeof sealCertificateInfo>[0]) => sealCertificateInfo(material).fingerprintSha256;
const storedValue = async (tenantId: string) =>
  (await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: SEAL_IDENTITY_KEY } }, select: { value: true } }))?.value ?? null;

async function cleanup() {
  await basePrisma.appSetting.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
  await basePrisma.errorLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
  await basePrisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
}

async function main() {
  guardEnvironment();
  // The server-wide certificate would win over everything this is testing.
  delete process.env.BUILDER_SIGN_P12_BASE64;
  delete process.env.BUILDER_SIGN_P12_PASSPHRASE;
  delete process.env.SIGNING_SECURITY_MODE;
  for (const [id, name] of [[tenantA, "Acme Carts"], [tenantB, "Other Motors"]]) {
    await basePrisma.tenant.create({ data: { id, name, slug: id, active: true } });
    await basePrisma.appSetting.create({ data: { tenantId: id, key: "COMPANY_NAME", value: name } });
  }

  try {
    console.log("\n== a workspace with no certificate");
    check("nothing is stored yet", (await storedSealIdentity(tenantA)) === null);
    check("and nothing is treated as its configured identity", (await configuredSealIdentity(tenantA)) === null);
    check("looking does not create one", (await storedValue(tenantA)) === null);

    console.log("\n== the first signatures arrive together");
    const racers = await Promise.all([ensureWorkspaceSealIdentity(tenantA), ensureWorkspaceSealIdentity(tenantA), ensureWorkspaceSealIdentity(tenantA)]);
    const prints = new Set(racers.map(fingerprint));
    check("three simultaneous first seals end up with ONE certificate", prints.size === 1, `${prints.size} different certificates`);
    check("one row was written", (await basePrisma.appSetting.count({ where: { tenantId: tenantA, key: SEAL_IDENTITY_KEY } })) === 1);
    const first = [...prints][0];
    const info = sealCertificateInfo(racers[0]);
    check("it is in the workspace's own name", /Acme Carts document seal/.test(info.subject), info.subject);
    check("it is the workspace's configured identity", racers[0].source === "workspace" && racers[0].trusted === true);

    console.log("\n== at rest");
    const value = (await storedValue(tenantA)) ?? "";
    check("the stored value is encrypted", value.startsWith("enc:v1:"), value.slice(0, 12));
    check("the private key is not readable in the row", !/BEGIN|passphrase|p12/.test(value));

    console.log("\n== after a restart");
    __resetSealIdentityCache();
    check("the same certificate is loaded again", fingerprint(await sealIdentityFor(tenantA)) === first);
    __resetSealIdentityCache();
    check("asking for it again never makes a second", fingerprint(await ensureWorkspaceSealIdentity(tenantA)) === first);
    check("the verifier is told the same one", fingerprint((await configuredSealIdentity(tenantA))!) === first);

    console.log("\n== another workspace");
    const other = await sealIdentityFor(tenantB);
    check("gets a certificate of its own", fingerprint(other) !== first);
    check("in its own name", /Other Motors document seal/.test(sealCertificateInfo(other).subject));
    __resetSealIdentityCache();
    check("and neither can load the other's", fingerprint((await storedSealIdentity(tenantA))!) === first && fingerprint((await storedSealIdentity(tenantB))!) === fingerprint(other));

    console.log("\n== a certificate that cannot be opened");
    await basePrisma.appSetting.update({
      where: { tenantId_key: { tenantId: tenantA, key: SEAL_IDENTITY_KEY } },
      data: { value: "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA" },
    });
    __resetSealIdentityCache();
    const fallback = await sealIdentityFor(tenantA);
    check("the document is still sealed — with a temporary certificate", fallback.source === "temporary" && fallback.trusted === false);
    const logged = await basePrisma.errorLog.findFirst({ where: { tenantId: tenantA, scope: "signing-seal-fallback" }, select: { context: true } });
    check("and it is reported, not silent", /TEMPORARY certificate/.test(logged?.context ?? ""), logged?.context?.slice(0, 60) ?? "nothing logged");
    check("the damaged row is left alone, not overwritten with a new certificate", (await storedValue(tenantA))?.endsWith(":AAAA") === true);
    check("and it is not offered to the verifier as the workspace's identity", (await configuredSealIdentity(tenantA)) === null);

    console.log("\n== no workspace at all");
    check("a seal with no workspace named is temporary", (await sealIdentityFor(null)).source === "temporary");
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
