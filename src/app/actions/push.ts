"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sendPushToAll } from "@/lib/push";
import { isAllowedPushEndpoint } from "@/lib/pushEndpoint";

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

export async function sendTestPush(): Promise<{ ok?: string; error?: string }> {
  const user = await requireUser();
  const sent = await sendPushToAll({
    title: "Denago CRM test 🔔",
    body: `Push notifications are working, ${user.name.split(" ")[0]}!`,
    url: "/",
  });
  return sent > 0
    ? { ok: `Sent to ${sent} device${sent !== 1 ? "s" : ""}.` }
    : { error: "No subscribed devices yet — enable notifications first." };
}
