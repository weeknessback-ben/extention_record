import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Recording } from './types';
import { broadcast } from './messages';

export interface Chunk {
  id?: number;
  recId: string;
  kind: 'video' | 'audio';
  /** Audio segment index (always 0 for video). */
  seg: number;
  seq: number;
  blob: Blob;
}

interface RecorderDB extends DBSchema {
  recordings: { key: string; value: Recording; indexes: { 'by-started': number } };
  chunks: { key: number; value: Chunk; indexes: { 'by-part': [string, string, number, number] } };
}

let dbPromise: Promise<IDBPDatabase<RecorderDB>> | undefined;

export function getDB(): Promise<IDBPDatabase<RecorderDB>> {
  dbPromise ??= openDB<RecorderDB>('meeting-recorder', 1, {
    upgrade(db) {
      const recs = db.createObjectStore('recordings', { keyPath: 'id' });
      recs.createIndex('by-started', 'startedAt');
      const chunks = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
      chunks.createIndex('by-part', ['recId', 'kind', 'seg', 'seq']);
    },
  });
  return dbPromise;
}

export async function listRecordings(): Promise<Recording[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('recordings', 'by-started');
  return all.reverse();
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  return (await getDB()).get('recordings', id);
}

export async function putRecording(rec: Recording): Promise<void> {
  await (await getDB()).put('recordings', rec);
  broadcast({ type: 'recordings-changed', recId: rec.id });
}

/**
 * Read-modify-write inside one transaction so concurrent writers (recorder,
 * pipeline, library page) never overwrite each other's fields.
 */
export async function updateRecording(
  id: string,
  patch: Partial<Recording> | ((rec: Recording) => Partial<Recording> | void),
  opts: { silent?: boolean } = {},
): Promise<Recording | undefined> {
  const db = await getDB();
  const tx = db.transaction('recordings', 'readwrite');
  const rec = await tx.store.get(id);
  if (!rec) {
    await tx.done;
    return undefined;
  }
  const changes = typeof patch === 'function' ? patch(rec) : patch;
  const next = { ...rec, ...(changes ?? {}) };
  await tx.store.put(next);
  await tx.done;
  if (!opts.silent) broadcast({ type: 'recordings-changed', recId: id });
  return next;
}

export async function addChunk(chunk: Chunk): Promise<void> {
  await (await getDB()).add('chunks', chunk);
}

function partRange(recId: string, kind: Chunk['kind'], seg: number) {
  return IDBKeyRange.bound([recId, kind, seg, 0], [recId, kind, seg, Infinity]);
}

export async function getChunks(recId: string, kind: Chunk['kind'], seg = 0): Promise<Blob[]> {
  const db = await getDB();
  const chunks = await db.getAllFromIndex('chunks', 'by-part', partRange(recId, kind, seg));
  return chunks.map((c) => c.blob);
}

export async function countChunks(recId: string, kind: Chunk['kind'], seg = 0): Promise<number> {
  return (await getDB()).countFromIndex('chunks', 'by-part', partRange(recId, kind, seg));
}

async function deleteRange(range: IDBKeyRange): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('chunks', 'readwrite');
  let cursor = await tx.store.index('by-part').openKeyCursor(range);
  while (cursor) {
    await tx.store.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await tx.done;
}

export function deleteChunks(recId: string, kind: Chunk['kind'], seg = 0): Promise<void> {
  return deleteRange(partRange(recId, kind, seg));
}

export async function deleteRecording(id: string): Promise<void> {
  // [id] sorts before every [id, ...] key and [id, []] after all of them.
  await deleteRange(IDBKeyRange.bound([id], [id, []]));
  await (await getDB()).delete('recordings', id);
  broadcast({ type: 'recordings-changed', recId: id });
}
