import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../src/app/manifest";
import { GET as messagesManifest } from "../src/app/messages/manifest.webmanifest/route";

test("CRM manifest exposes launcher shortcuts inside the root app scope", () => {
  const data = manifest();

  assert.deepEqual(
    data.shortcuts?.map(({ name, url }) => ({ name, url })),
    [
      { name: "New lead", url: "/leads/new?source=pwa-shortcut" },
      { name: "New contact", url: "/contacts/new?source=pwa-shortcut" },
      { name: "Open pipeline", url: "/leads?source=pwa-shortcut" },
    ],
  );

  for (const shortcut of data.shortcuts ?? []) {
    assert.ok(shortcut.url.startsWith("/"));
  }
});

test("Messages manifest exposes launcher shortcuts inside the messages scope", async () => {
  const response = messagesManifest();
  const data = await response.json();

  assert.deepEqual(
    data.shortcuts.map(({ name, url }: { name: string; url: string }) => ({ name, url })),
    [
      { name: "Open chats", url: "/messages?source=pwa-shortcut" },
      { name: "Open help desk", url: "/messages/cases?source=pwa-shortcut" },
    ],
  );

  for (const shortcut of data.shortcuts) {
    assert.ok(shortcut.url.startsWith("/messages"));
  }
  assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
});
