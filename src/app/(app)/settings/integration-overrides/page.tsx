import { redirect } from "next/navigation";

/** Integration overrides are part of the one Integrations page now (batch 6). */
export default function IntegrationOverridesPage() {
  redirect("/settings/integrations");
}
