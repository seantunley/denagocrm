"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { pushConfigured, pushRecipientsForCurrentScope, sendPushToAll } from "@/lib/push";
import { isAllowedPushEndpoint } from "@/lib/pushEndpoint";
import { withActingStaffScope } from "@/lib/actingScope";

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

/**
 * Send a test push to this workspace's subscribed devices.
 *
 * TWO DEFECTS FIXED HERE, and the second one is why the first was so hard to see.
 *
 * 1. NO TENANT SCOPE. This is a Server Action, and a Server Action does not
 *    inherit the scope a page render establishes — the same discovery as #520.
 *    With enforcement on, `pushRecipientsForCurrentScope()` therefore found the
 *    scope CLOSED and correctly returned nobody, so the test always sent to zero
 *    devices. `withActingStaffScope` binds an enclosing frame from the session,
 *    which is the shape that actually reaches the callee.
 *
 * 2. ONE SENTENCE FOR FIVE OUTCOMES. "No subscribed devices yet" was returned
 *    whenever `sendPushToAll` came back with 0 — which it does when the VAPID
 *    keys are missing, when the scope is closed, when every send fails, and when
 *    there genuinely are no devices. It told the owner to go and enable
 *    notifications they had already enabled, on a screen whose own button said
 *    "Disable on this device". Each cause now says what it is.
 */
export async function sendTestPush(): Promise<{ ok?: string; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    if (!pushConfigured()) {
      return { error: "Push is not configured on this server — the VAPID keys are missing." };
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
    const sent = await sendPushToAll({
      title: "Denago CRM test 🔔",
      body: `Push notifications are working, ${user.name.split(" ")[0]}!`,
      url: "/",
    });
    if (sent === 0) {
      return {
        error: `Found ${devices.length} subscribed device${devices.length === 1 ? "" : "s"}, but the push service rejected every one. Dead subscriptions are removed automatically — re-enable notifications on the device and try again.`,
      };
    }
    return {
      ok:
        sent === devices.length
          ? `Sent to ${sent} device${sent !== 1 ? "s" : ""}.`
          : `Sent to ${sent} of ${devices.length} devices — the rest were unreachable.`,
    };
  });
}
