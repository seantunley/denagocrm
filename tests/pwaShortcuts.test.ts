import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import manifest from "../src/app/manifest";
import { GET as messagesManifest } from "../src/app/messages/manifest.webmanifest/route";
import { readPwaActivityShortcut } from "../src/lib/pwaShortcuts";

function assertPngShortcutIcon(icon: {
  src: string;
  sizes: string;
  type: string;
}) {
  assert.equal(icon.type, "image/png");
  assert.equal(icon.sizes, "192x192");

  const png = readFileSync(join(process.cwd(), "public", icon.src));
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(png.readUInt32BE(16), 192);
  assert.equal(png.readUInt32BE(20), 192);
}

test("CRM manifest exposes launcher shortcuts inside the root app scope", () => {
  const data = manifest();

  assert.deepEqual(
    data.shortcuts?.map(({ name, url, icons }) => ({
      name,
      url,
      icon: icons?.[0]?.src,
    })),
    [
      {
        name: "New Lead",
        url: "/leads/new?source=pwa-shortcut",
        icon: "/icons/shortcut-lead-192.png",
      },
      {
        name: "New Contact",
        url: "/contacts/new?source=pwa-shortcut",
        icon: "/icons/shortcut-contact-192.png",
      },
      {
        name: "New Activity",
        url: "/calendar?quick-create=activity&source=pwa-shortcut",
        icon: "/icons/shortcut-activity-192.png",
      },
    ],
  );

  for (const shortcut of data.shortcuts ?? []) {
    assert.ok(shortcut.url.startsWith("/"));

    const icon = shortcut.icons?.[0];
    assert.ok(icon);
    assertPngShortcutIcon(icon);
  }
});

test("activity launcher URL opens once and keeps unrelated calendar state", () => {
  assert.deepEqual(
    readPwaActivityShortcut(
      "https://crm.example/calendar?m=week&quick-create=activity&source=pwa-shortcut#today",
    ),
    { cleanUrl: "/calendar?m=week#today" },
  );
  assert.equal(
    readPwaActivityShortcut(
      "https://crm.example/calendar?quick-create=activity",
    ),
    null,
  );
});

test("Messages manifest exposes launcher shortcuts inside the messages scope", async () => {
  const response = messagesManifest();
  const data = await response.json();

  assert.deepEqual(
    data.shortcuts.map(
      ({
        name,
        url,
        icons,
      }: {
        name: string;
        url: string;
        icons: { src: string }[];
      }) => ({ name, url, icon: icons[0]?.src }),
    ),
    [
      {
        name: "Open chats",
        url: "/messages?source=pwa-shortcut",
        icon: "/icons/shortcut-chats-192.png",
      },
      {
        name: "Open help desk",
        url: "/messages/cases?source=pwa-shortcut",
        icon: "/icons/shortcut-helpdesk-192.png",
      },
    ],
  );

  for (const shortcut of data.shortcuts) {
    assert.ok(shortcut.url.startsWith("/messages"));
    assertPngShortcutIcon(shortcut.icons[0]);
  }
  assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
});
