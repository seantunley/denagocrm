import "server-only";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { docKeyAvailable } from "@/lib/docTemplates";

/**
 * Server-side twin of Document Studio's module filter. Hiding a module-only
 * document (job card, indemnity, delivery…) in the UI did not stop a workspace
 * without that module creating one by posting its key, or opening, rendering or
 * exporting an existing one by id. Every template read and create goes through
 * this; a disabled document behaves as if it does not exist.
 */
export async function docKeyEnabled(key: string): Promise<boolean> {
  return docKeyAvailable(key, await getEnabledModuleIds());
}
