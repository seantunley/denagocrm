"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { collectSource, discoverSources, researchCompetitor, isSafeUrl, DISCOVERABLE_TYPES } from "@/lib/competitors";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function createCompetitor(formData: FormData) {
  const user = await requirePermission("competitors.manage");
  const name = str(formData, "name");
  if (!name) throw new Error("Give the competitor a name");
  const website = str(formData, "website") || null;
  const tierRaw = parseInt(str(formData, "tier") || "2", 10);
  const competitor = await prisma.competitor.create({
    data: {
      name,
      website,
      description: str(formData, "description") || null,
      tier: [1, 2, 3].includes(tierRaw) ? tierRaw : 2,
      createdById: user.id,
    },
  });
  await logAudit({ action: "competitor.created", summary: `Added competitor "${name}"`, user });
  redirect(`/competitors/${competitor.id}`);
}

export async function updateCompetitor(id: string, formData: FormData) {
  const user = await requirePermission("competitors.manage");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const tierRaw = parseInt(str(formData, "tier") || "2", 10);
  await prisma.competitor.update({
    where: { id },
    data: {
      name,
      website: str(formData, "website") || null,
      description: str(formData, "description") || null,
      notes: str(formData, "notes") || null,
      tier: [1, 2, 3].includes(tierRaw) ? tierRaw : 2,
      status: str(formData, "status") === "archived" ? "archived" : "active",
    },
  });
  await logAudit({ action: "competitor.updated", summary: `Updated competitor "${name}"`, user });
  revalidatePath(`/competitors/${id}`);
  revalidatePath("/competitors");
}

export async function deleteCompetitor(id: string) {
  const user = await requirePermission("competitors.manage");
  const competitor = await prisma.competitor.findUnique({ where: { id } });
  await prisma.competitor.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({ action: "competitor.deleted", summary: `Deleted competitor "${competitor?.name ?? id}"`, user });
  redirect("/competitors");
}

export async function addSource(competitorId: string, formData: FormData) {
  const user = await requirePermission("competitors.manage");
  const url = str(formData, "url");
  const label = str(formData, "label") || url;
  // Same SSRF-safe validator used by the watcher — rejects private/internal hosts.
  if (!isSafeUrl(url)) throw new Error("Enter a valid public http(s) URL");
  const rawType = str(formData, "sourceType");
  const sourceType = DISCOVERABLE_TYPES.includes(rawType) ? rawType : "page";
  // The parent competitor must exist and be live before we create a child row.
  const competitor = await prisma.competitor.findFirst({ where: { id: competitorId, deletedAt: null }, select: { id: true } });
  if (!competitor) throw new Error("Competitor not found");
  // Prevent duplicate canonical URLs on the same competitor.
  const dupe = await prisma.competitorSource.findFirst({ where: { competitorId, url } });
  if (dupe) throw new Error("That URL is already watched for this competitor");
  await prisma.competitorSource.create({
    data: { competitorId, url, label, sourceType },
  });
  await logAudit({ action: "competitor.source_added", summary: `Watching ${url}`, user, entityType: "Competitor", entityId: competitorId });
  revalidatePath(`/competitors/${competitorId}`);
}

export async function deleteSource(competitorId: string, sourceId: string) {
  await requirePermission("competitors.manage");
  // Scope the delete to the parent competitor (and require it live) so a mismatched
  // competitorId/sourceId pair can't delete another competitor's source.
  const result = await prisma.competitorSource.deleteMany({
    where: { id: sourceId, competitorId, competitor: { deletedAt: null } },
  });
  if (result.count !== 1) throw new Error("Source not found");
  revalidatePath(`/competitors/${competitorId}`);
}

/** Run one source right now (manual "check now"). */
export async function runSourceNow(competitorId: string, sourceId: string) {
  await requirePermission("competitors.manage");
  // Confirm the source belongs to this (live) competitor before collecting.
  const source = await prisma.competitorSource.findFirst({
    where: { id: sourceId, competitorId, competitor: { deletedAt: null } },
    select: { id: true },
  });
  if (!source) throw new Error("Source not found");
  await collectSource(sourceId);
  revalidatePath(`/competitors/${competitorId}`);
}

/** Strong-model discovery: find the competitor's pages + social profiles. */
export async function discoverSourcesNow(competitorId: string) {
  const user = await requirePermission("competitors.research");
  const result = await discoverSources(competitorId, user.id);
  await logAudit({
    action: "competitor.discovered",
    summary: result.ok
      ? `AI discovery added ${result.created} source(s)`
      : `AI discovery failed: ${result.error ?? "unknown"}`,
    user,
    entityType: "Competitor",
    entityId: competitorId,
  });
  revalidatePath(`/competitors/${competitorId}`);
}

/** Strong-model deep research: write a fresh intelligence brief. */
export async function researchNow(competitorId: string) {
  const user = await requirePermission("competitors.research");
  const result = await researchCompetitor(competitorId, user.id);
  await logAudit({
    action: "competitor.researched",
    summary: result.ok ? "AI intelligence brief created" : `AI research failed: ${result.error ?? "unknown"}`,
    user,
    entityType: "Competitor",
    entityId: competitorId,
  });
  revalidatePath(`/competitors/${competitorId}`);
}

export async function reviewChange(competitorId: string, changeId: string, decision: "reviewed" | "dismissed") {
  const user = await requirePermission("competitors.review");
  // Scope the update to the parent (live) competitor; count===1 confirms the pair.
  const result = await prisma.competitorChange.updateMany({
    where: { id: changeId, competitorId, competitor: { deletedAt: null } },
    data: { status: decision, reviewedById: user.id, reviewedAt: new Date() },
  });
  if (result.count !== 1) throw new Error("Change not found");
  revalidatePath(`/competitors/${competitorId}`);
  revalidatePath("/competitors");
}
