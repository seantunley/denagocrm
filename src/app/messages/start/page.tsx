import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";

// Permission-aware landing for the installed Messages PWA (the manifest's
// start_url). The app can be installed from either Chats (/messages, inbox perms)
// or Help desk (/messages/cases, cases perms), so a fixed start_url of /messages
// would bounce a cases-only user straight out of the app. Route each user to a
// page they can actually open, falling back to the main CRM.
export const dynamic = "force-dynamic";

export default async function MessagesStartPage() {
  const user = await requireUser();
  if (await hasAnyPermission(user, "inbox.view", "inbox.reply")) redirect("/messages");
  if (await hasAnyPermission(user, "cases.view_all", "cases.view_owned")) redirect("/messages/cases");
  redirect("/");
}
