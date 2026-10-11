"use server";

import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePermission, canAccessContact } from "@/lib/permissions";
import { requireTenantOwner } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { putSetting, getSetting } from "@/lib/settings";
import { DEFAULT_POLICY, parseMode, parsePolicy, type ScreeningPolicy } from "@/lib/inboundScreening/rules";
import { SCREENING_MODE_SETTING, SCREENING_POLICY_SETTING } from "@/lib/inboundScreening/screen";
import { ReviewRefusal, labelObservedNotSpam, labelSpam, markThreadSpam, restoreScreening, setPatternStatus, setSenderRule } from "@/lib/inboundScreening/review";

/**
 * Reviewing quarantine. Every action: the `inbox.spam` permission, the acting
 * workspace, and that workspace named in every statement the library runs —
 * an id posted from a browser is only ever looked up inside it. Each decision
 * is audited; none of them writes message text to the audit trail or a log.
 */

const MODE_LABEL = { off: "Off", observe: "Observe only", quarantine: "Quarantine" } as const;

async function reviewing<T>(fn: (ctx: { tenantId: string; by: { id: string; name: string } }) => Promise<T>): Promise<T> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("inbox.spam");
    try {
      return await fn({ tenantId: await actingTenantId(), by: { id: user.id, name: user.name } });
    } catch (error) {
      if (error instanceof ReviewRefusal) refuse(error.message);
      throw error;
    }
  });
}

const done = () => { revalidatePath("/inbox"); revalidatePath("/messages"); };
const idList = (ids: string[]) => [...new Set(ids.filter((id) => typeof id === "string" && id))].slice(0, 100);

/** "Not spam — restore", for one message or a ticked batch. */
export async function restoreSpam(ids: string[]): Promise<ActionResult> {
  return asActionResult(() => reviewing(async ({ tenantId, by }) => {
    let restored = 0;
    const problems: string[] = [];
    for (const id of idList(ids)) {
      try {
        await restoreScreening(tenantId, id, by);
        restored += 1;
        await logAudit({ action: "inbox.spam.restored", summary: "Restored a quarantined message to the inbox", entityType: "InboundScreening", entityId: id, userName: by.name });
      } catch (error) {
        if (!(error instanceof ReviewRefusal)) throw error;
        problems.push(error.message);
      }
    }
    done();
    if (restored === 0) refuse(problems[0] ?? "Nothing was restored.");
    return { success: `${restored === 1 ? "Restored" : `Restored ${restored} messages`} to the inbox. The chatbot did not reply — ${restored === 1 ? "it needs" : "they need"} a person.${problems.length ? ` ${problems.length} could not be restored: ${problems[0]}` : ""}` };
  }));
}

/** Confirm quarantined messages as spam (they stay in quarantine, and become examples). */
export async function confirmSpam(ids: string[]): Promise<ActionResult> {
  return asActionResult(() => reviewing(async ({ tenantId, by }) => {
    const n = await labelSpam(tenantId, idList(ids), by);
    if (n === 0) refuse("Those messages are no longer here.");
    await logAudit({ action: "inbox.spam.confirmed", summary: `Confirmed ${n} quarantined message${n === 1 ? "" : "s"} as spam`, entityType: "InboundScreening", userName: by.name, metadata: { count: n } });
    done();
    return { success: n === 1 ? "Marked as spam" : `Marked ${n} as spam` };
  }));
}

/** Observe mode has already admitted the message: feedback must not replay it. */
export async function correctObservedSpam(ids: string[]): Promise<ActionResult> {
  return asActionResult(() => reviewing(async ({ tenantId, by }) => {
    const count = await labelObservedNotSpam(tenantId, idList(ids), by);
    if (!count) refuse("Those observed messages are no longer here.");
    await logAudit({ action: "inbox.spam.corrected", summary: `Marked ${count} observed messages as not spam`, entityType: "InboundScreening", userName: by.name, metadata: { count } });
    done();
    return { success: "Recorded as not spam. The messages were already in your inbox; nothing was replayed." };
  }));
}

/** Block, always allow, or clear the decision — for the SENDER of one screened message. */
export async function decideSender(screeningId: string, rule: "allow" | "block" | "clear"): Promise<ActionResult> {
  return asActionResult(() => reviewing(async ({ tenantId, by }) => {
    const row = await basePrisma.inboundScreening.findFirst({ where: { id: screeningId, tenantId }, select: { channel: true, senderId: true, senderName: true } });
    if (!row) refuse("That message is no longer here.");
    await setSenderRule(tenantId, row!.channel, row!.senderId, rule === "clear" ? null : rule, by, row!.senderName);
    await logAudit({
      action: `inbox.sender.${rule === "clear" ? "rule_cleared" : rule === "block" ? "blocked" : "allowed"}`,
      summary: rule === "block" ? `Blocked a ${row!.channel} sender` : rule === "allow" ? `Set a ${row!.channel} sender to always allowed` : `Removed the rule for a ${row!.channel} sender`,
      entityType: "InboundSenderRule", entityId: `${row!.channel}:${row!.senderId}`, userName: by.name,
    });
    done();
    return { success: rule === "block" ? "Sender blocked — their messages go straight to quarantine" : rule === "allow" ? "Sender always allowed — their messages are never held" : "Rule removed" };
  }));
}

/** Remove a sender rule from the rules list. */
export async function clearSenderRule(ruleId: string): Promise<ActionResult> {
  return asActionResult(() => reviewing(async ({ tenantId, by }) => {
    const rule = await basePrisma.inboundSenderRule.findFirst({ where: { id: ruleId, tenantId } });
    if (!rule) refuse("That rule is no longer here.");
    await setSenderRule(tenantId, rule!.channel, rule!.senderId, null, by);
    await logAudit({ action: "inbox.sender.rule_cleared", summary: `Removed the ${rule!.rule} rule for a ${rule!.channel} sender`, entityType: "InboundSenderRule", entityId: `${rule!.channel}:${rule!.senderId}`, userName: by.name });
    done();
    return { success: "Rule removed" };
  }));
}

/** Spam the filter missed: mark a conversation that is already in the inbox. */
export async function markConversationSpam(contactId: string, channel: string): Promise<ActionResult> {
  return markConversationAsSpam(contactId, channel, false);
}

export async function markAndBlockConversationSpam(contactId: string, channel: string): Promise<ActionResult> {
  return markConversationAsSpam(contactId, channel, true);
}

async function markConversationAsSpam(contactId: string, channel: string, blockSender: boolean): Promise<ActionResult> {
  return asActionResult(() => reviewing(async ({ tenantId, by }) => {
    const user = await requirePermission("inbox.spam");
    if (!["whatsapp", "messenger", "instagram"].includes(channel)) refuse("That channel isn't screened.");
    if (!(await canAccessContact(user, contactId))) refuse("You don't have access to that customer.");
    const n = await markThreadSpam(tenantId, contactId, channel, by, blockSender);
    await logAudit({ action: "inbox.spam.marked", summary: "Marked a conversation as spam and archived it", entityType: "Contact", entityId: contactId, contactId, userName: by.name, metadata: { channel, examples: n, blockSender } });
    done();
    return { success: blockSender ? "Marked as spam and archived. Sender blocked when Quarantine mode is enabled." : "Marked as spam and archived. You can review or block this sender in Spam → Missed spam." };
  }));
}

/* ── owner only: the mode, the thresholds, the broad rules ─────────────── */

export async function saveScreeningSettings(formData: FormData): Promise<ActionResult> {
  return asActionResult(() => withActingStaffScope(async () => {
    const owner = await requireTenantOwner();
    const mode = parseMode(String(formData.get("mode") ?? ""));
    const num = (key: keyof ScreeningPolicy) => Number(formData.get(key) ?? DEFAULT_POLICY[key]);
    const policy = parsePolicy(JSON.stringify({
      repeatSimilarity: num("repeatSimilarity"), repeatMinWords: num("repeatMinWords"), burstCount: num("burstCount"),
      burstWindowSeconds: num("burstWindowSeconds"), aiQuarantine: formData.get("aiQuarantine") === "never" ? "never" : "strong",
      aiPerSenderPerHour: num("aiPerSenderPerHour"), aiPerWorkspacePerDay: num("aiPerWorkspacePerDay"), aiTimeoutMs: num("aiTimeoutMs"),
    }));
    const before = parseMode(await getSetting(SCREENING_MODE_SETTING));
    await putSetting(SCREENING_MODE_SETTING, mode);
    await putSetting(SCREENING_POLICY_SETTING, JSON.stringify(policy));
    await logAudit({
      action: "inbox.spam.settings", summary: before === mode ? "Changed the spam filter's limits" : `Spam filter set to ${MODE_LABEL[mode]} (was ${MODE_LABEL[before]})`,
      entityType: "AppSetting", entityId: SCREENING_MODE_SETTING, userName: owner.name, metadata: { before, after: mode, policy },
    });
    done();
    return { success: `Spam filter: ${MODE_LABEL[mode]}` };
  }));
}

export async function decideSpamPattern(patternId: string, status: "active" | "disabled"): Promise<ActionResult> {
  return asActionResult(() => withActingStaffScope(async () => {
    const owner = await requireTenantOwner();
    const tenantId = await actingTenantId();
    try {
      await setPatternStatus(tenantId, patternId, status, { id: owner.id, name: owner.name });
    } catch (error) {
      if (error instanceof ReviewRefusal) refuse(error.message);
      throw error;
    }
    await logAudit({ action: "inbox.spam.rule", summary: status === "active" ? "Switched a spam rule on" : "Switched a spam rule off", entityType: "InboundSpamPattern", entityId: patternId, userName: owner.name });
    done();
    return { success: status === "active" ? "Rule on — matching messages go to quarantine" : "Rule off" };
  }));
}
