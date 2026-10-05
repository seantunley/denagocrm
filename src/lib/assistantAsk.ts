import "server-only";
import { isModuleEnabled } from "./modules/enabled";
import { askCrm, type AskOptions, type AssistantResult } from "./crmAssistant";
import { ASK_LIMIT_MESSAGE, assistantAskAllowed, assistantImageAllowed } from "./assistantUser";
import { MAX_IMAGE_BYTES, cleanJpeg, jpegDataUrl } from "./assistantImage";
import type { PermissionUser } from "./permissions";

/**
 * Asking DAX from the CRM (the streaming route, /api/assistant/ask). The caller
 * has already established the signed-in person and their assistant permission;
 * everything after that happens here, in this order:
 * the Automation module → the question → the person's hourly ask limit → an
 * attached image (its own limit; JPEG only, size-capped, rebuilt by
 * cleanJpeg) → askCrm. Read-only: nothing here writes a record.
 */
export async function askAsPerson(
  user: PermissionUser,
  input: { question: unknown; page: unknown; image: unknown },
  live: Pick<AskOptions, "onAnswerText" | "onProgress"> = {},
): Promise<AssistantResult> {
  // The page hides it with the module off; the action must refuse on its own.
  if (!(await isModuleEnabled("automation"))) {
    return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
  }
  const file = input.image;
  const hasImage = file instanceof File && file.size > 0;
  const q = String(input.question ?? "").trim().slice(0, 500) || (hasImage ? "What's in this image, and what should I do with it?" : "");
  if (!q) return { ok: false, error: "Type a question first." };
  if (!(await assistantAskAllowed(user.id))) return { ok: false, error: ASK_LIMIT_MESSAGE };
  let images: string[] = [];
  if (hasImage) {
    if (!(await assistantImageAllowed(user.id))) return { ok: false, error: "That's a lot of images this hour — give it a while and try again." };
    if (file.size > MAX_IMAGE_BYTES || file.type !== "image/jpeg") {
      return { ok: false, error: "That image couldn't be used — try a photo or screenshot again." };
    }
    const cleaned = cleanJpeg(new Uint8Array(await file.arrayBuffer()));
    if (!cleaned) return { ok: false, error: "That image couldn't be read — try a photo or screenshot again." };
    images = [jpegDataUrl(cleaned)];
  }
  // `page` is only a hint ("this lead"); pageHint reads a record id out of it
  // and the tools re-check access, so a forged path finds nothing new.
  const page = typeof input.page === "string" ? input.page.slice(0, 200) : null;
  return askCrm(user, q, page, { images, onAnswerText: live.onAnswerText, onProgress: live.onProgress });
}
