"use client";

import {
  OFFLINE_DB_VERSION,
  OFFLINE_MAX_AGE_MS,
  type OfflineDescriptor,
  type OfflineField,
  type OfflineMutation,
  type OfflineSnapshot,
} from "./offlineTypes";

const DB_NAME = "denago-offline";
const MUTATIONS = "mutations";
const SNAPSHOTS = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MUTATIONS)) db.createObjectStore(MUTATIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

export async function serialiseForm(formData: FormData): Promise<OfflineField[]> {
  const fields: OfflineField[] = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") fields.push({ name, kind: "text", value });
    else if (value.size > 0) {
      fields.push({ name, kind: "file", value, fileName: value.name, contentType: value.type });
    }
  }
  return fields;
}

export async function queueOfflineMutation(
  tenantId: string,
  userId: string,
  operation: OfflineDescriptor,
  formData: FormData,
): Promise<OfflineMutation[]> {
  if (!tenantId || !userId) throw new Error("Offline work requires an active workspace and user.");
  const fields = await serialiseForm(formData);
  const isPhoto = operation.type === "jobcard.photo" || operation.type === "inspection.photo" || operation.type === "delivery.photo";
  const textFields = fields.filter((field) => field.kind === "text");
  const fileFields = fields.filter((field) => field.kind === "file");
  const batches = isPhoto && fileFields.length > 0
    ? fileFields.map((file) => [...textFields, file])
    : [fields];
  const entries = batches.map((batch): OfflineMutation => ({
    id: crypto.randomUUID(),
    tenantId,
    userId,
    operation,
    fields: batch,
    createdAt: Date.now(),
    attempts: 0,
    status: "pending",
  }));
  const db = await openDb();
  const tx = db.transaction(MUTATIONS, "readwrite");
  for (const entry of entries) tx.objectStore(MUTATIONS).put(entry);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return entries;
}

export async function listOfflineMutations(tenantId: string, userId: string): Promise<OfflineMutation[]> {
  const db = await openDb();
  const all = await request(db.transaction(MUTATIONS).objectStore(MUTATIONS).getAll()) as OfflineMutation[];
  db.close();
  return all
    .filter((entry) => entry.tenantId === tenantId && entry.userId === userId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveOfflineMutation(entry: OfflineMutation): Promise<void> {
  const db = await openDb();
  await request(db.transaction(MUTATIONS, "readwrite").objectStore(MUTATIONS).put(entry));
  db.close();
}

/**
 * Queue a refused change again, as a NEW change.
 *
 * ── WHY A NEW ID AND NOT A RETRY ────────────────────────────────────────────
 *
 * The server keeps a receipt per mutation id, and a refused one is CLOSED as
 * rejected — that is what makes replays at-most-once. Sending the same id again
 * therefore returns the stored rejection forever, however the record has changed
 * since. A retry that could never succeed is worse than no retry button.
 *
 * So this is a fresh mutation carrying the same work: new id, new receipt, and a
 * `baseVersion` the caller has re-read from the current snapshot. That makes the
 * meaning honest — the person has SEEN the refusal and the record's current
 * state, and is choosing to apply their values on top of it. The old entry is
 * removed only after the new one is stored, so a failure here leaves the work
 * queued rather than nowhere.
 */
export async function requeueOfflineMutation(
  entry: OfflineMutation,
  baseVersion?: string,
): Promise<OfflineMutation> {
  const next: OfflineMutation = {
    ...entry,
    id: crypto.randomUUID(),
    operation: { ...entry.operation, ...(baseVersion ? { baseVersion } : {}) },
    createdAt: Date.now(),
    attempts: 0,
    status: "pending",
    error: undefined,
  };
  await saveOfflineMutation(next);
  await removeOfflineMutation(entry.id);
  return next;
}

export async function removeOfflineMutation(id: string): Promise<void> {
  const db = await openDb();
  await request(db.transaction(MUTATIONS, "readwrite").objectStore(MUTATIONS).delete(id));
  db.close();
}

export async function saveOfflineSnapshot(snapshot: OfflineSnapshot): Promise<void> {
  const db = await openDb();
  await request(db.transaction(SNAPSHOTS, "readwrite").objectStore(SNAPSHOTS).put({
    key: `${snapshot.tenantId}:${snapshot.userId}`,
    ...snapshot,
  }));
  db.close();
}

export async function loadOfflineSnapshot(tenantId: string, userId: string): Promise<OfflineSnapshot | null> {
  const db = await openDb();
  const value = await request(db.transaction(SNAPSHOTS).objectStore(SNAPSHOTS).get(`${tenantId}:${userId}`));
  db.close();
  const snapshot = (value as OfflineSnapshot | undefined) ?? null;
  if (snapshot && Date.now() - snapshot.capturedAt > OFFLINE_MAX_AGE_MS) return null;
  return snapshot;
}

export async function purgeOfflineData(tenantId?: string, userId?: string): Promise<void> {
  const db = await openDb();
  if (!tenantId || !userId) {
    await Promise.all([
      request(db.transaction(MUTATIONS, "readwrite").objectStore(MUTATIONS).clear()),
      request(db.transaction(SNAPSHOTS, "readwrite").objectStore(SNAPSHOTS).clear()),
    ]);
  } else {
    const mutations = await request(db.transaction(MUTATIONS).objectStore(MUTATIONS).getAll()) as OfflineMutation[];
    const tx = db.transaction(MUTATIONS, "readwrite");
    for (const entry of mutations) {
      if (entry.tenantId !== tenantId || entry.userId !== userId) tx.objectStore(MUTATIONS).delete(entry.id);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const snapshots = await request(db.transaction(SNAPSHOTS).objectStore(SNAPSHOTS).getAll()) as Array<OfflineSnapshot & { key: string }>;
    const snapTx = db.transaction(SNAPSHOTS, "readwrite");
    for (const snapshot of snapshots) {
      if (snapshot.tenantId !== tenantId || snapshot.userId !== userId) snapTx.objectStore(SNAPSHOTS).delete(snapshot.key);
    }
    await new Promise<void>((resolve, reject) => {
      snapTx.oncomplete = () => resolve();
      snapTx.onerror = () => reject(snapTx.error);
    });
  }
  db.close();
}

export function mutationExpired(entry: OfflineMutation): boolean {
  return Date.now() - entry.createdAt > OFFLINE_MAX_AGE_MS;
}
