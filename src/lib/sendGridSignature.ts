import crypto from "node:crypto";

/** Verify Twilio SendGrid's ECDSA signature over timestamp + exact raw payload. */
export function verifySendGridSignature(input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  rawBody: string;
}): boolean {
  try {
    const keyValue = input.publicKey.trim();
    const publicKey = keyValue.startsWith("-----BEGIN")
      ? crypto.createPublicKey(keyValue)
      : crypto.createPublicKey({
          key: Buffer.from(keyValue, "base64"),
          format: "der",
          type: "spki",
        });
    return crypto.verify(
      "sha256",
      Buffer.from(input.timestamp + input.rawBody, "utf8"),
      publicKey,
      Buffer.from(input.signature, "base64"),
    );
  } catch {
    return false;
  }
}
