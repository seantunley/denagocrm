import type { CaptureKind, EntryStatus } from "./types";
import {
  OFFLINE_TTL_MS,
  QUEUE_DB_NAME,
  QUEUE_DB_VERSION,
  QUEUE_STORE_NAME,
  SESSION_STORE_NAME,
  notifyOfflineState,
  offlineScopeKey,
  type OfflineScope,
  type QueuedPhoto,
} from "./queue";

export type DeviceSessionEntry = {
  id: string;
  itemId: string;
  labelSnapshot: string;
  descriptionSnapshot: string | null;
  captureSnapshot: CaptureKind;
  requiredSnapshot: boolean;
  minPhotosSnapshot: number;
  maxPhotos: number;
  sortOrder: number;
  status: EntryStatus;
  note: string | null;
  value: string | null;
  skipReason: string | null;
  photoCount: number;
  photos: Array<{ id: string; url: string }>;
};

export type DeviceChecklistSession = {
  key: string;
  scopeKey: string;
  tenantId: string;
  userId: string;
  runId: string;
  hostType: string;
  hostId: string;
  templateId: string;
  templateVersion: number;
  startedAt: string;
  entries: DeviceSessionEntry[];
  dirty: boolean;
  updatedAt: string;
  expiresAt: string;
};

type SessionDraft = Omit<DeviceChecklistSession, "key" | "scopeKey" | "tenantId" | "userId" | "updatedAt" | "expiresAt">;

function available(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!available()) return null;
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(QUEUE_DB_NAME, QUEUE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        let photos: IDBObjectStore;
        if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
          photos = db.createObjectStore(QUEUE_STORE_NAME, { keyPath: "id" });
        } else {
          photos = request.transaction!.objectStore(QUEUE_STORE_NAME);
          photos.clear();
          if (photos.indexNames.contains("runId")) photos.deleteIndex("runId");
        }
        if (!photos.indexNames.contains("scopeRun")) {
          photos.createIndex("scopeRun", ["scopeKey", "runId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
          db.createObjectStore(SESSION_STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Offline storage could not be opened."));
      request.onblocked = () => reject(new Error("Offline storage is busy in another tab."));
    });
  } catch {
    return null;
  }
}

function request<T>(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = work(tx.objectStore(storeName));
    result.onsuccess = () => resolve(result.result);
    result.onerror = () => reject(result.error ?? new Error("Offline storage refused the operation."));
    tx.onabort = () => reject(tx.error ?? new Error("Offline storage aborted the operation."));
  });
}

export async function saveDeviceSession(scope: OfflineScope, draft: SessionDraft): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const now = new Date();
  const scopeKey = offlineScopeKey(scope);
  const row: DeviceChecklistSession = {
    ...draft,
    key: `${scopeKey}:${draft.runId}`,
    scopeKey,
    tenantId: scope.tenantId,
    userId: scope.userId,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OFFLINE_TTL_MS).toISOString(),
  };
  await request(db, SESSION_STORE_NAME, "readwrite", (store) => store.put(row));
  db.close();
  notifyOfflineState();
  return true;
}

export async function loadDeviceSession(
  scope: OfflineScope,
  target: { hostType: string; hostId: string; templateId: string },
): Promise<DeviceChecklistSession | null> {
  const db = await openDb();
  if (!db) return null;
  const rows = await request<DeviceChecklistSession[]>(db, SESSION_STORE_NAME, "readonly", (store) => store.getAll());
  db.close();
  const now = Date.now();
  return rows
    .filter((row) =>
      row.scopeKey === offlineScopeKey(scope) &&
      Date.parse(row.expiresAt) > now &&
      row.hostType === target.hostType &&
      row.hostId === target.hostId &&
      row.templateId === target.templateId,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function deleteDeviceSession(scope: OfflineScope, runId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await request(db, SESSION_STORE_NAME, "readwrite", (store) => store.delete(`${offlineScopeKey(scope)}:${runId}`));
  db.close();
  notifyOfflineState();
}

export async function purgeChecklistDeviceData(scope: OfflineScope): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const [sessions, photos] = await Promise.all([
    request<DeviceChecklistSession[]>(db, SESSION_STORE_NAME, "readonly", (store) => store.getAll()),
    request<QueuedPhoto[]>(db, QUEUE_STORE_NAME, "readonly", (store) => store.getAll()),
  ]);
  const wanted = offlineScopeKey(scope);
  const now = Date.now();
  for (const row of sessions) {
    if (row.scopeKey !== wanted || Date.parse(row.expiresAt) <= now) {
      await request(db, SESSION_STORE_NAME, "readwrite", (store) => store.delete(row.key));
    }
  }
  for (const row of photos) {
    if (row.scopeKey !== wanted || Date.parse(row.expiresAt) <= now) {
      await request(db, QUEUE_STORE_NAME, "readwrite", (store) => store.delete(row.id));
    }
  }
  db.close();
  notifyOfflineState();
}

export async function clearChecklistDeviceData(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await request(db, QUEUE_STORE_NAME, "readwrite", (store) => store.clear());
  await request(db, SESSION_STORE_NAME, "readwrite", (store) => store.clear());
  db.close();
  notifyOfflineState();
}

export async function offlinePendingCount(scope: OfflineScope): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const [sessions, photos] = await Promise.all([
    request<DeviceChecklistSession[]>(db, SESSION_STORE_NAME, "readonly", (store) => store.getAll()),
    request<QueuedPhoto[]>(db, QUEUE_STORE_NAME, "readonly", (store) => store.getAll()),
  ]);
  db.close();
  const wanted = offlineScopeKey(scope);
  const now = Date.now();
  return photos.filter((row) => row.scopeKey === wanted && Date.parse(row.expiresAt) > now).length +
    sessions.filter((row) => row.scopeKey === wanted && row.dirty && Date.parse(row.expiresAt) > now).length;
}
