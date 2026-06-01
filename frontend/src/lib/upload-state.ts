import type { CommitFileItem } from "./api";

const DB_NAME = "nyy-upload";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const SESSION_TTL_MS = 72 * 60 * 60 * 1000;

export interface StoredCommitItem extends CommitFileItem {
  commit_token_expires_at: string;
}

export interface MultipartPartState {
  part_index: number;
  crc32: string;
}

export interface UploadSessionFile {
  file_key: string;
  upload_name: string;
  file_name: string;
  file_size: number;
  last_modified: number;
  logical_file_id: string;
  chunk_total: number;
  commit_items: Array<StoredCommitItem | null>;
  multipart?: {
    multipart_token: string;
    store_uri: string;
    tos_host: string;
    tos_auth: string;
    upload_id: string;
    part_size: number;
    part_number_base: number;
    part_count: number;
    commit_token: string;
    commit_token_expires_at: string;
    parts: Array<MultipartPartState | null>;
    merged: boolean;
  };
}

export interface UploadSession {
  upload_batch_id: string;
  file_keys: string[];
  files: UploadSessionFile[];
  empty_dirs: string[];
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export function getUploadFileKey(uploadName: string, file: File): string {
  return `${uploadName}:${file.size}:${file.lastModified}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("当前浏览器不支持断点续传");

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "upload_batch_id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

export async function saveUploadSession(session: UploadSession): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(session);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function findUploadSession(fileKeys: string[], emptyDirs: string[]): Promise<UploadSession | null> {
  const now = Date.now();
  const sortedKeys = [...fileKeys].sort().join("|");
  const sortedEmptyDirs = [...emptyDirs].sort().join("|");
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    const sessions = await requestToPromise<UploadSession[]>(tx.objectStore(STORE_NAME).getAll());
    await txDone(tx);
    return sessions.find((session) => (
      session.expires_at > now && [...session.file_keys].sort().join("|") === sortedKeys
      && [...session.empty_dirs].sort().join("|") === sortedEmptyDirs
    )) || null;
  } finally {
    db.close();
  }
}

export async function deleteUploadSession(uploadBatchId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(uploadBatchId);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function clearExpiredUploadSessions(): Promise<void> {
  const now = Date.now();
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const session = cursor.value as UploadSession;
      if (session.expires_at <= now) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => tx.abort();
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function markUploadChunkComplete(
  uploadBatchId: string,
  fileKey: string,
  chunkIndex: number,
  item: StoredCommitItem,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(uploadBatchId);

      request.onsuccess = () => {
        const session = request.result as UploadSession | undefined;
        if (!session) {
          tx.abort();
          return;
        }
        const file = session.files.find((candidate) => candidate.file_key === fileKey);
        if (!file) {
          tx.abort();
          return;
        }
        file.commit_items[chunkIndex] = item;
        session.updated_at = Date.now();
        store.put(session);
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("断点续传状态保存失败"));
      tx.onabort = () => reject(tx.error || new Error("断点续传状态保存失败"));
    });
  } finally {
    db.close();
  }
}

async function mutateSessionFile(
  uploadBatchId: string, fileKey: string,
  mutate: (file: UploadSessionFile) => void,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(uploadBatchId);
      request.onsuccess = () => {
        const session = request.result as UploadSession | undefined;
        if (!session) { tx.abort(); return; }
        const file = session.files.find((c) => c.file_key === fileKey);
        if (!file) { tx.abort(); return; }
        mutate(file);
        session.updated_at = Date.now();
        store.put(session);
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("断点续传状态保存失败"));
      tx.onabort = () => reject(tx.error || new Error("断点续传状态保存失败"));
    });
  } finally {
    db.close();
  }
}

export async function markMultipartInit(
  uploadBatchId: string, fileKey: string,
  mpu: NonNullable<UploadSessionFile["multipart"]>,
): Promise<void> {
  return mutateSessionFile(uploadBatchId, fileKey, (file) => { file.multipart = mpu; });
}

export async function markMultipartPartComplete(
  uploadBatchId: string, fileKey: string, partIndex: number,
  part: MultipartPartState,
): Promise<void> {
  return mutateSessionFile(uploadBatchId, fileKey, (file) => {
    if (file.multipart) file.multipart.parts[partIndex] = part;
  });
}

export async function markMultipartMerged(
  uploadBatchId: string, fileKey: string,
  commitToken: string, commitTokenExpiresAt: string,
): Promise<void> {
  return mutateSessionFile(uploadBatchId, fileKey, (file) => {
    if (file.multipart) {
      file.multipart.merged = true;
      file.multipart.commit_token = commitToken;
      file.multipart.commit_token_expires_at = commitTokenExpiresAt;
    }
  });
}

export function createUploadSession(params: {
  uploadBatchId: string;
  fileKeys: string[];
  files: UploadSessionFile[];
  emptyDirs: string[];
}): UploadSession {
  const now = Date.now();
  return {
    upload_batch_id: params.uploadBatchId,
    file_keys: params.fileKeys,
    files: params.files,
    empty_dirs: params.emptyDirs,
    created_at: now,
    updated_at: now,
    expires_at: now + SESSION_TTL_MS,
  };
}
