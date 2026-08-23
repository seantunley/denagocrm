"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { pushConfigured, pushRecipientsForCurrentScope, sendPushToAll } from "@/lib/push";
import { isAllowedPushEndpoint } from "@/lib/pushEndpoint";
import { withActingStaffScope } from "@/lib/actingScope";
import { getSetting } from "@/lib/settings";

export async function savePushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}) {
  const user = await requireUser();
  // The endpoint comes from the browser and was stored verbatim, so any
  // authenticated user could make the server POST to a URL of their choosing —
  // and sendPushToAll fires those requests on ordinary app events. Refuse at the
  // write, so a bad endpoint never reaches the database; lib/push.ts checks
  // again at the send, for rows that predate this.
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    throw new Error("That push endpoint is not a recognised push service.");
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, userId: user.id, userName: user.name },
    create: {
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userId: user.id,
      userName: user.name,
    },
  });
}

export async function removePushSubscription(endpoint: string) {
  const user = await requireUser();
  // Scope the delete to THIS user's own device. deleteMany by endpoint alone let
  // a user who learned another device's endpoint unsubscribe that device.
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
}

type PushTestOptions = {
  mode?: "crm" | "messages";
  /** Correlates the provider send with the service worker on the device testing it. */
  testId?: string;
};

/**
 * Send a test push to this workspace's subscribed devices.
 *
 * THREE details matter here:
 *
 * 1. A Server Action does not inherit the tenant scope a page render establishes,
 *    so the whole diagnostic must run inside withActingStaffScope.
 * 2. The Messages PWA must test the SAME notification kind as a real social DM.
 *    A generic test bypasses the `dm` preference and can say "working" while real
 *    Messenger / Instagram pushes are deliberately disabled.
 * 3. A provider accepting the request is not proof that the CURRENT phone showed
 *    it. `testId` travels in the URL and the worker reports display success/failure
 *    back to the open page so PushToggle can distinguish those outcomes.
 */
export async function sendTestPush(
  options: PushTestOptions = {},
): Promise<{ ok?: string; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const messagesMode = options.mode === "messages";
    if (!pushConfigured()) {
      return { error: "Push is not configured on this server — the VAPID keys are missing." };
    }

    if (messagesMode) {
      const disabled = (await getSetting("PUSH_DISABLED_KINDS"))
        ?.split(",")
        .map((kind) => kind.trim())
        .filter(Boolean);
      if (disabled?.includes("dm")) {
        return {
          error:
            "Social DM notifications are disabled in Settings → Notifications. Enable Social DMs, then test again.",
        };
      }
    }

    // Resolved BEFORE sending, so "found nobody" and "found somebody and failed"
    // are answerable separately. This is the diagnostic path; the fire-and-forget
    // callers keep the cheap single count.
    const devices = await pushRecipientsForCurrentScope();
    if (devices.length === 0) {
      return {
        error:
          "No subscribed devices for this workspace yet — enable notifications on a device, then try again.",
      };
    }

    const safeTestId = options.testId?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96);
    const baseUrl = messagesMode ? "/messages" : "/";
    const destination = safeTestId
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}push-test=${encodeURIComponent(safeTestId)}`
      : baseUrl;
    const kind = messagesMode ? "dm" : undefined;

    const sent = await sendPushToAll(
      {
        title: messagesMode ? "Denago Messages test 🔔" : "Denago CRM test 🔔",
        body: `Push notifications are working, ${user.name.split(" ")[0]}!`,
        url: destination,
      },
      kind,
    );
    if (sent === 0) {
      return {
        error: `Found ${devices.length} subscribed device${devices.length === 1 ? "" : "s"}, but the push service rejected every one. Dead subscriptions are removed automatically — re-enable notifications on the device and try again.`,
      };
    }
    return {
      ok:
        sent === devices.length
          ? `Push service accepted the test for ${sent} device${sent !== 1 ? "s" : ""}.`
          : `Push service accepted the test for ${sent} of ${devices.length} devices — the rest were unreachable.`,
    };
  });
}
