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

export async function pollChatGptLogin() {
  const user = await requireOwner();
  const result = await pollCodexLogin();
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
  await disconnectCodex();
  await logAudit({
    action: "integration.chatgpt_disconnected",
    summary: "Disconnected the ChatGPT subscription; research falls back to the Anthropic key",
    user,
  });
  revalidatePath("/settings");
}

export async function testChatGpt() {
  await requireOwner();
  return testCodexConnection();
}
