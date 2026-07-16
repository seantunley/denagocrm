"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { collectSource, discoverSources, researchCompetitor } from "@/lib/competitors";

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
  if (!/^https?:\/\//i.test(url)) throw new Error("Enter a full http(s) URL");
  await prisma.competitorSource.create({
    data: {
      competitorId,
      url,
      label,
      sourceType: str(formData, "sourceType") || "page",
    },
  });
  await logAudit({ action: "competitor.source_added", summary: `Watching ${url}`, user, entityType: "Competitor", entityId: competitorId });
  revalidatePath(`/competitors/${competitorId}`);
}

export async function deleteSource(competitorId: string, sourceId: string) {
  await requirePermission("competitors.manage");
  await prisma.competitorSource.delete({ where: { id: sourceId } });
  revalidatePath(`/competitors/${competitorId}`);
}

/** Run one source right now (manual "check now"). */
export async function runSourceNow(competitorId: string, sourceId: string) {
  await requirePermission("competitors.manage");
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
  await prisma.competitorChange.update({
    where: { id: changeId },
    data: { status: decision, reviewedById: user.id, reviewedAt: new Date() },
  });
  revalidatePath(`/competitors/${competitorId}`);
  revalidatePath("/competitors");
}
