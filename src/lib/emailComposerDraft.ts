import { EMAIL_UPLOAD_MAX_BYTES, EMAIL_UPLOAD_MAX_FILES } from "./emailUploads";
import { SECURE_LINK_DAYS } from "./secureLinks";

export type EmailComposerDraft = {
  to: string; cc: string; bcc: string; replyTo: string;
  subject: string; body: string; banner: string; dealId: string;
  attached: string[]; attachedQuotes: string[]; uploads: File[];
  secure: boolean; days: number;
};
export const EMAIL_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const DB = "crm-email-composer-v1";
const STORE = "drafts";
type SavedDraft = { key: string; version: 1; savedAt: number; data: EmailComposerDraft };

/** Browser storage is untrusted. Old/corrupt drafts must not break composing. */
export function validEmailDraft(value: unknown, key: string, now = Date.now()): value is SavedDraft {
  if (!value || typeof value !== "object") return false;
  const row = value as SavedDraft;
  if (row.key !== key || row.version !== 1 || !Number.isFinite(row.savedAt) || row.savedAt > now || now - row.savedAt > EMAIL_DRAFT_TTL || !row.data) return false;
  const data = row.data;
  if (![data.to, data.cc, data.bcc, data.replyTo, data.subject, data.body, data.banner, data.dealId].every((v) => typeof v === "string" && v.length <= 8_000_000)) return false;
  if (![data.attached, data.attachedQuotes].every((v) => Array.isArray(v) && v.length <= 100 && v.every((id) => typeof id === "string" && id.length < 200))) return false;
  if (!Array.isArray(data.uploads) || data.uploads.length > EMAIL_UPLOAD_MAX_FILES || !data.uploads.every((f) => typeof File !== "undefined" && f instanceof File) || data.uploads.reduce((size, file) => size + file.size, 0) > EMAIL_UPLOAD_MAX_BYTES) return false;
  return typeof data.secure === "boolean" && (SECURE_LINK_DAYS as readonly number[]).includes(data.days);
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("Draft storage unavailable")); };
  });
}
export async function readEmailDraft(key: string): Promise<EmailComposerDraft | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      let found: EmailComposerDraft | null = null;
      const cursor = tx.objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (!validEmailDraft(entry.value, String(entry.key))) entry.delete();
        else if (entry.key === key) found = entry.value.data;
        entry.continue();
      };
      tx.oncomplete = () => resolve(found);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function writeEmailDraft(key: string, data: EmailComposerDraft | null): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (data) store.put({ key, version: 1, savedAt: Date.now(), data } satisfies SavedDraft);
      else store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
