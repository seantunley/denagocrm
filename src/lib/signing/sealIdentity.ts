import "server-only";
import crypto from "crypto";
import { basePrisma } from "@/lib/db";
import { decryptValue, encryptValue } from "@/lib/settings";
import { getCompanyProfile } from "@/lib/companyProfile";
import { logError } from "@/lib/errorLog";
import { signingSecurityMode, assertSigningRuntimeReady } from "./securityPolicy";
import { selfSignedP12, serverSealMaterial, temporarySealMaterial, type SealMaterial } from "./sealMaterial";

/**
 * The certificate that seals a workspace's signed PDFs.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * The seal came from a PKCS#12 in the server's environment, and when that was
 * absent it fell back to a certificate generated in memory — named "Denago
 * Development Seal", different on every server start, and the same name for
 * every workspace. That fallback was meant for a laptop. On live the
 * environment value went missing some time after August, nothing said so, and a
 * customer's contract was sealed with a throwaway certificate.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * Each workspace gets ONE certificate of its own, in its own company's name,
 * made the first time it is needed and kept — encrypted — with the workspace's
 * settings. Every document that workspace completes is sealed with it, so a seal
 * can be recognised as theirs from one document to the next.
 *
 * It is self-signed, deliberately (owner's decision, 2026-10-09: a purchased
 * certificate is not worth its yearly cost). A PDF reader therefore reports the
 * signer as "not verified" — and still reports, correctly, whether the document
 * has been changed since it was sealed, which is what the seal is for.
 *
 * The environment certificate still wins when one is configured: that is the
 * operator's override, and what strict mode requires.
 */

/** Stored with the workspace's settings; a credential, encrypted at rest (SECRET_KEYS in lib/settings.ts). */
export const SEAL_IDENTITY_KEY = "SIGNING_SEAL_IDENTITY";

type StoredIdentity = { v: 1; p12: string; passphrase: string; createdAt: string };

/** ponytail: no renewal. Ten years out the certificate lapses and this needs a "make a new one, keep the old fingerprint" path. */
const VALID_YEARS = 10;

const loaded = new Map<string, SealMaterial>();

/** Test seam: forget what this process has loaded. */
export function __resetSealIdentityCache(): void {
  loaded.clear();
}

function parseStored(value: string): SealMaterial | null {
  const stored = JSON.parse(decryptValue(value)) as Partial<StoredIdentity>;
  if (stored.v !== 1 || typeof stored.p12 !== "string" || typeof stored.passphrase !== "string") return null;
  return { p12: Buffer.from(stored.p12, "base64"), passphrase: stored.passphrase, source: "workspace", trusted: true };
}

async function readStored(tenantId: string): Promise<SealMaterial | null> {
  const row = await basePrisma.appSetting.findUnique({
    where: { tenantId_key: { tenantId, key: SEAL_IDENTITY_KEY } },
    select: { value: true },
  });
  return row?.value ? parseStored(row.value) : null;
}

/**
 * This workspace's stored certificate, or null when it has none yet. Never
 * creates one — for a screen, or a verifier, that only wants what is there.
 */
export async function storedSealIdentity(tenantId: string): Promise<SealMaterial | null> {
  return loaded.get(tenantId) ?? (await readStored(tenantId));
}

/**
 * Make this workspace's certificate if it has none, and return the one it has.
 *
 * Two completions can arrive together on a workspace's very first signature.
 * `createMany … skipDuplicates` against the (tenant, key) unique index lets
 * exactly one of them write; both then read back the same row, so two documents
 * are never sealed by two different "first" certificates.
 */
export async function ensureWorkspaceSealIdentity(tenantId: string): Promise<SealMaterial> {
  const existing = loaded.get(tenantId) ?? (await readStored(tenantId));
  if (existing) {
    loaded.set(tenantId, existing);
    return existing;
  }
  const company = (await getCompanyProfile(tenantId).catch(() => null))?.name?.trim() || "Workspace";
  const passphrase = crypto.randomBytes(24).toString("base64url");
  const identity: StoredIdentity = {
    v: 1,
    p12: selfSignedP12(`${company} document seal`, company, passphrase, VALID_YEARS).toString("base64"),
    passphrase,
    createdAt: new Date().toISOString(),
  };
  // encryptValue REFUSES to return clear text in production without a key, so a
  // private key is never written unencrypted: that throws, and the caller falls
  // back and says so.
  await basePrisma.appSetting.createMany({
    data: [{ tenantId, key: SEAL_IDENTITY_KEY, value: encryptValue(JSON.stringify(identity)) }],
    skipDuplicates: true,
  });
  const stored = await readStored(tenantId);
  if (!stored) throw new Error("the workspace seal certificate could not be read back after it was stored");
  loaded.set(tenantId, stored);
  return stored;
}

/**
 * The identity this workspace is CONFIGURED to seal with, for checking a
 * document that claims to be sealed by it. Never creates one, and never the
 * temporary certificate: a temporary seal is not anybody's configured identity.
 */
export async function configuredSealIdentity(tenantId: string | null | undefined): Promise<SealMaterial | null> {
  return serverSealMaterial() ?? (tenantId ? await storedSealIdentity(tenantId).catch(() => null) : null);
}

/**
 * What seals a document for this workspace, right now.
 *
 * Never throws for a missing or unreadable workspace certificate: a customer has
 * already signed by the time this runs, and losing their signature to our own
 * key handling would be the worse failure. It seals with a temporary certificate
 * instead and REPORTS it — to the system log, which alerts — because the last
 * time a fallback like this was silent it went unnoticed for weeks.
 */
export async function sealIdentityFor(tenantId: string | null | undefined): Promise<SealMaterial> {
  const server = serverSealMaterial();
  if (server) return server;
  if (signingSecurityMode() === "strict") {
    // Strict mode is a promise that only the configured certificate ever seals.
    assertSigningRuntimeReady("PDF sealing");
    throw new Error("Trusted PDF signing identity is unavailable");
  }
  if (!tenantId) return temporarySealMaterial();
  try {
    return await ensureWorkspaceSealIdentity(tenantId);
  } catch (error) {
    await logError(
      "signing-seal-fallback",
      error,
      "A signed document was sealed with a TEMPORARY certificate because this workspace's own certificate could not be loaded or created. The document is sealed and valid, but its seal will not match the workspace certificate. See Settings → Signing security.",
      { tenantId },
    ).catch(() => {});
    return temporarySealMaterial();
  }
}
