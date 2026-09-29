"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  disconnectCodex,
  pollCodexLogin,
  startCodexLogin,
  testCodexConnection,
} from "@/lib/codex";

/**
 * Connecting a ChatGPT subscription to the workspace.
 *
 * OWNER ONLY, every action, including the poll. The sign-in decides which
 * ChatGPT account every future research call is billed against, and the
 * tokens it stores act as that account. `requireOwner` decides who may do it;
 * the settings storage decides WHICH workspace it lands in, from the request
 * scope, so one workspace cannot connect or read another's.
 */

export async function startChatGptLogin() {
  await requireOwner();
  return startCodexLogin();
}

export async function pollChatGptLogin(shownUserCode: unknown) {
  const user = await requireOwner();
  // From the browser, so checked here: only ever compared with the stored code,
  // never forwarded, but a non-string must not reach it.
  if (typeof shownUserCode !== "string" || !shownUserCode.trim() || shownUserCode.length > 64) {
    return { state: "expired" as const };
  }
  const result = await pollCodexLogin(shownUserCode.trim());
  if ("state" in result && result.state === "connected") {
    await logAudit({
      action: "integration.chatgpt_connected",
      summary: "Connected a ChatGPT subscription for lead research",
      user,
    });
    revalidatePath("/settings");
  }
  return result;
}

export async function disconnectChatGpt() {
  const user = await requireOwner();
  const { revoked } = await disconnectCodex();
  await logAudit({
    action: "integration.chatgpt_disconnected",
    summary: revoked
      ? "Disconnected the ChatGPT subscription and revoked its sign-in at OpenAI; research falls back to the Anthropic key"
      : "Disconnected the ChatGPT subscription; OpenAI could not be reached to revoke the sign-in, so it was only cleared here",
    user,
  });
  revalidatePath("/settings");
  return { revoked };
}

export async function testChatGpt() {
  await requireOwner();
  return testCodexConnection();
}
