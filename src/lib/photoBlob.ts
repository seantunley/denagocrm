export type PhotoBlobAccess = "private" | "public";

type PhotoBlobEnv = {
  BLOB_PRIVATE?: string;
  BLOB_PRIVATE_READ_WRITE_TOKEN?: string;
  BLOB_READ_WRITE_TOKEN?: string;
};

/**
 * Keep direct photo uploads on the same store policy as the rest of document
 * storage. The application deliberately uses a second token for the staged
 * private store, rather than silently switching the existing public store.
 */
export function photoBlobAccess(env: PhotoBlobEnv = process.env): PhotoBlobAccess {
  return env.BLOB_PRIVATE === "true" ? "private" : "public";
}

/**
 * Select the token for the store implied by {@link photoBlobAccess}. Private
 * mode fails closed exactly like saveFile(): falling back to the public token
 * would make a sensitive upload public while appearing to honour the flag.
 */
export function photoBlobToken(env: PhotoBlobEnv = process.env): string | undefined {
  if (photoBlobAccess(env) === "private") {
    const token = env.BLOB_PRIVATE_READ_WRITE_TOKEN;
    if (!token) {
      throw new Error("BLOB_PRIVATE=true requires BLOB_PRIVATE_READ_WRITE_TOKEN");
    }
    return token;
  }
  return env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Only the browser's token-exchange request carries the staff session. The
 * upload-completed request is a signed server-to-server callback from Vercel
 * Blob and therefore must never be gated on actingTenantId().
 */
export function photoUploadNeedsStaffSession(type: unknown): boolean {
  return type === "blob.generate-client-token";
}
