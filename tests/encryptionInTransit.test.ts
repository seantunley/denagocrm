import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { probeSmtp } from "../src/lib/integrationProbe";

/**
 * Mail credentials and customer mail never cross the network in clear text.
 *
 * On port 587 (encryption "off" in settings) nodemailer used STARTTLS only if the
 * server offered it, and imapflow the same for IMAP — so a server that didn't,
 * or an attacker stripping the offer, got the mailbox password and every message
 * unencrypted. Both now REQUIRE the upgrade and fail without it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** An SMTP server that never offers encryption and accepts any password. */
function plaintextSmtpServer(): Promise<{ port: number; sawAuth: () => boolean; close: () => void }> {
  let auth = false;
  const server = net.createServer((socket) => {
    socket.write("220 plaintext.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") socket.write("250-plaintext.test\r\n250 AUTH PLAIN\r\n");
        else if (verb === "STARTTLS") socket.write("502 5.5.1 STARTTLS not supported\r\n");
        else if (verb === "AUTH") { auth = true; socket.write("235 2.7.0 Authentication successful\r\n"); }
        else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 OK\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, sawAuth: () => auth, close: () => server.close() });
    });
  });
}

test("A MAIL SERVER THAT CAN'T ENCRYPT IS REFUSED — the password is never sent", async () => {
  const server = await plaintextSmtpServer();
  try {
    const result = await probeSmtp({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      user: "sales@example.test",
      pass: "not-a-real-password",
      from: "sales@example.test",
    });
    assert.equal(result.ok, false, "the connection test fails");
    assert.equal(server.sawAuth(), false, "and the password never reached the server");
  } finally {
    server.close();
  }
});

test("real sends and the IMAP sync require encryption the same way", () => {
  assert.match(src("src/lib/email.ts"), /secure: config\.secure,[\s\S]{0,400}requireTLS: !config\.secure,/);
  assert.match(src("src/lib/integrationProbe.ts"), /secure: input\.secure,[\s\S]{0,300}requireTLS: !input\.secure,/);
  const imap = src("src/lib/imapSync.ts");
  assert.match(imap, /\.\.\.\(secure \? \{\} : \{ doSTARTTLS: true \}\),/);
  assert.ok(!/doSTARTTLS: false/.test(imap), "never a fully unencrypted IMAP connection");
});
