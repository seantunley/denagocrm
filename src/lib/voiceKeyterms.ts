import "server-only";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { getCompanyProfile } from "./companyProfile";
import { listActingTenantStaff } from "./tenantActor";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "./assistantSoul";
import { sttKeyterms } from "./elevenlabs";
import { PRONUNCIATIONS_KEY, parsePronunciations } from "./spokenText";
import { STT_CUSTOMER_NAMES_KEY } from "./voiceSettings";

/**
 * The names a voice note in THIS workspace is likely to contain (Sean, 2026-11-02: better transcription): the
 * business and assistant names, the workspace's pronunciation words, its products, its staff — and, only with the
 * switch on, its customers with open deals. Read through the workspace's own client. Never fails: no hints is
 * the old behaviour.
 */
export async function voiceKeyterms(): Promise<string[]> {
  try {
    const [company, profileRaw, pronunciations, customersOn] = await Promise.all([
      getCompanyProfile().catch(() => null),
      getSetting(ASSISTANT_PROFILE_KEY).catch(() => null),
      getSetting(PRONUNCIATIONS_KEY).catch(() => null),
      getSetting(STT_CUSTOMER_NAMES_KEY).catch(() => null),
    ]);
    const [products, staff, customers] = await Promise.all([
      prisma.product.findMany({ where: { active: true, deletedAt: null }, select: { name: true }, orderBy: { name: "asc" }, take: 40 }).catch(() => []),
      listActingTenantStaff().catch(() => []),
      customersOn === "on"
        ? prisma.lead.findMany({ where: { status: "open", deletedAt: null }, select: { name: true }, orderBy: { updatedAt: "desc" }, take: 30 }).catch(() => [])
        : Promise.resolve([] as { name: string }[]),
    ]);
    return sttKeyterms([
      company?.name,
      parseProfile(profileRaw).name,
      ...parsePronunciations(pronunciations).map(([word]) => word),
      ...products.map((p) => p.name),
      ...staff.map((s) => s.name),
      ...customers.map((c) => c.name),
    ]);
  } catch {
    return [];
  }
}
