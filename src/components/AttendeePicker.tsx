/**
 * "Also attending": the other staff at a meeting besides the person it is
 * assigned to. Posts `attendeeIds` (one per ticked box) and `attendeesShown`,
 * which tells an edit that this form manages the list — an edit from a form
 * without the picker leaves the attendees alone.
 */
export function AttendeePicker({
  users,
  defaultIds = [],
  className,
}: {
  users: { id: string; name: string }[];
  defaultIds?: string[];
  className?: string;
}) {
  if (users.length < 2) return null;
  return (
    <fieldset className={className}>
      <legend className="label">Also attending</legend>
      <input type="hidden" name="attendeesShown" value="1" />
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {users.map((user) => (
          <label key={user.id} className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="attendeeIds"
              value={user.id}
              defaultChecked={defaultIds.includes(user.id)}
              className="h-4 w-4 accent-orange-600"
            />
            {user.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
