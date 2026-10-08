import { redirect } from "next/navigation";
import { requireRoute } from "@/lib/permissions";

/**
 * Public comments on posts and ads now live in the Social inbox, as their own
 * Comments tab (see src/app/(app)/inbox/page.tsx). Old links land there.
 */
export default async function CommentsPage() {
  await requireRoute("/comments");
  redirect("/inbox?tab=comments");
}
