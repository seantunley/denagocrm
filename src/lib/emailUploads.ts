/**
 * Files attached to an email straight from the sender's computer (Sean,
 * 2026-10-07), checked before anything is sent: a few files, a sensible total
 * (the whole request must also fit the 16 MB server-action limit, with the
 * message), and no programs or scripts — a customer's mail filter would bounce
 * the message, and it is never what a dealership means to send.
 */
export const EMAIL_UPLOAD_MAX_FILES = 5;
export const EMAIL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const BLOCKED = /\.(exe|bat|cmd|com|scr|msi|msp|ps1|psm1|vbs|vbe|js|jse|jar|wsf|wsh|hta|cpl|lnk|reg|sh|app|dmg|apk)$/i;

type UploadLike = { name: string; size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> };

export function emailUploads(formData: { getAll(name: string): unknown[] }): { files: UploadLike[] } | { error: string } {
  // An empty file input still posts one nameless, zero-byte entry: not a file.
  const files = formData.getAll("upload").filter(
    (f): f is UploadLike => typeof f === "object" && f !== null && "arrayBuffer" in f && Boolean((f as UploadLike).name) && (f as UploadLike).size > 0,
  );
  if (files.length > EMAIL_UPLOAD_MAX_FILES) return { error: `Attach at most ${EMAIL_UPLOAD_MAX_FILES} files from your computer.` };
  const blocked = files.find((f) => BLOCKED.test(f.name));
  if (blocked) return { error: `“${blocked.name}” can't be emailed — programs and scripts are blocked.` };
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > EMAIL_UPLOAD_MAX_BYTES) {
    return { error: `Uploaded attachments come to ${(total / 1024 / 1024).toFixed(1)} MB — keep them under ${EMAIL_UPLOAD_MAX_BYTES / 1024 / 1024} MB in total.` };
  }
  return { files };
}
