"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import {
  JOURNEY_TRIGGERS,
  archiveJourney,
  createJourney,
  journeyDefinitionSchema,
  publishJourney,
  saveJourneyDraft,
  toggleJourney,
  type JourneyTrigger,
} from "@/lib/marketingJourneys";

function bool(formData: FormData, key: string, defaultValue = false) {
  const value = formData.get(key);
  if (value == null) return defaultValue;
  return value === "on" || value === "true" || value === "1";
}

function parse(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const trigger = String(formData.get("trigger") ?? "") as JourneyTrigger;
  const definitionText = String(formData.get("definition") ?? "").trim();
  const frequencyCapHours = Math.max(0, Number(formData.get("frequencyCapHours") ?? 24) || 0);
  if (!name) throw new Error("Journey name is required");
  if (!JOURNEY_TRIGGERS.includes(trigger)) throw new Error("Unsupported journey trigger");
  let raw: unknown;
  try {
    raw = JSON.parse(definitionText);
  } catch {
    throw new Error("Journey definition is not valid JSON");
  }
  const definition = journeyDefinitionSchema.parse(raw);
  return {
    name,
    description,
    trigger,
    definition,
    stopOnReply: bool(formData, "stopOnReply", false),
    respectMarketingConsent: bool(formData, "respectMarketingConsent", false),
    frequencyCapHours,
  };
}

export async function createMarketingJourney(formData: FormData) {
  const user = await requireOwner();
  const input = parse(formData);
  const id = await createJourney({ ...input, createdById: user.id });
  revalidatePath("/automations");
  redirect(`/automations/journeys/${id}`);
}

export async function saveMarketingJourney(id: string, formData: FormData) {
  const user = await requireOwner();
  await saveJourneyDraft(id, { ...parse(formData), userId: user.id });
  revalidatePath("/automations");
  revalidatePath(`/automations/journeys/${id}`);
}

export async function publishMarketingJourney(id: string) {
  await requireOwner();
  await publishJourney(id);
  revalidatePath("/automations");
  revalidatePath(`/automations/journeys/${id}`);
}

export async function toggleMarketingJourney(id: string) {
  await requireOwner();
  await toggleJourney(id);
  revalidatePath("/automations");
  revalidatePath(`/automations/journeys/${id}`);
}

export async function archiveMarketingJourney(id: string) {
  await requireOwner();
  await archiveJourney(id);
  revalidatePath("/automations");
  redirect("/automations");
}
