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
  return withActingStaffScope(async () => {
    const user = await requireUser();
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
  });
}

export async function removePushSubscription(endpoint: string) {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
  });
}

type PushTestOptions = {
  mode?: "crm" | "messages";
  /** Correlates the provider send with the service worker on the device testing it. */
  testId?: string;
  /** The exact local PushSubscription endpoint. Tests must prove THIS device works. */
  endpoint?: string;
};

/**
 * Send a diagnostic push.
 *
 * Messages tests are intentionally different from ordinary broadcast pushes:
 * the browser supplies its own saved endpoint and the server verifies that the
 * endpoint belongs to the current workspace before sending. Previously the test
 * broadcast to every subscribed device, so one other phone accepting the push
 * produced "Sent to 2 devices" while the phone in the user's hand received none.
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

    const devices = await pushRecipientsForCurrentScope();
    if (devices.length === 0) {
      return {
        error:
          "No subscribed devices for this workspace yet — enable notifications on this device, then try again.",
      };
    }

    const targetEndpoint = options.endpoint?.trim();
    if (messagesMode && !targetEndpoint) {
      return {
        error:
          "This Messages app is using an old notification test. Close and reopen the app, tap Repair notifications, then test again.",
      };
    }
    if (targetEndpoint && !devices.some((device) => device.endpoint === targetEndpoint)) {
      return {
        error:
          "This device's push subscription is not registered in this workspace. Tap Repair notifications, then test again.",
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
      { endpoint: targetEndpoint || undefined },
    );

    const attempted = targetEndpoint ? 1 : devices.length;
    if (sent === 0) {
      return {
        error: targetEndpoint
          ? "The push service rejected this device's subscription. Tap Repair notifications to replace it, then test again."
          : `Found ${devices.length} subscribed device${devices.length === 1 ? "" : "s"}, but the push service rejected every one. Dead subscriptions are removed automatically — re-enable notifications and try again.`,
      };
    }
    return {
      ok:
        sent === attempted
          ? targetEndpoint
            ? "This device's push service accepted the test."
            : `Push service accepted the test for ${sent} device${sent !== 1 ? "s" : ""}.`
          : `Push service accepted the test for ${sent} of ${attempted} devices — the rest were unreachable.`,
    };
  });
}
