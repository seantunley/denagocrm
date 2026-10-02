import { resolveAssignableUser } from "./tenantActor";

/**
 * The other staff a form says are attending, besides the assignee.
 *
 * Each goes through the same assignment contract as the assignee — a posted id
 * from outside this workspace is refused, not dropped — and the assignee is not
 * repeated as their own attendee.
 */
export async function resolveAttendees(
  formData: FormData,
  assigneeId: string,
): Promise<{ id: string; name: string }[]> {
  const ids = Array.from(
    new Set(formData.getAll("attendeeIds").map((value) => String(value).trim()).filter(Boolean)),
  ).filter((id) => id !== assigneeId);
  const people: { id: string; name: string }[] = [];
  for (const id of ids) {
    const member = await resolveAssignableUser(id, "attendee");
    if (member) people.push({ id: member.id, name: member.name });
  }
  return people;
}

/** Everyone at an activity, owner first: what the calendar and reminders show. */
export function activityPeople(activity: {
  assignedTo: { name: string };
  attendees?: { user: { name: string } }[];
}): string[] {
  return [activity.assignedTo.name, ...(activity.attendees ?? []).map((row) => row.user.name)];
}
