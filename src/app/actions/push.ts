"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sendPushToAll } from "@/lib/push";

export async function savePushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}) {
  const user = await requireUser();
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
  await requireUser();
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
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
