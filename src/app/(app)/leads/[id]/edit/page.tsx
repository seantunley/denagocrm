import { redirect } from "next/navigation";
import { requireLeadAccess } from "@/lib/permissions";

/**
 * The lead is edited in ONE place: the "Edit details" modal on the lead page.
 * This page used to be a second copy of that form; old links and bookmarks now
 * land on the lead with the editor open.
 */
export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Same demand updateLead makes, so a read-only user is not sent to an editor.
  await requireLeadAccess(id, "leads.edit");
  redirect(`/leads/${id}?edit=1`);
}
