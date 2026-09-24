import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  query,
  runTransaction,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";

const CACHE_TTL_MS = 30_000;
const collectionCache = new Map();
const documentCache = new Map();

function collectionCacheKey(collectionName, constraints = []) {
  return `${collectionName}:${constraints
    .map((constraint) => JSON.stringify(constraint))
    .join("|")}`;
}

async function getCachedDocuments(
  collectionName,
  constraints = [],
  { force = false } = {},
) {
  if (!db) throw new Error("Firebase is not configured.");

  const cacheKey = collectionCacheKey(collectionName, constraints);
  const cached = collectionCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.items;
  }
  if (!force && cached?.promise) return cached.promise;

  const request = getDocs(
    query(collection(db, collectionName), ...constraints),
  ).then((snapshot) => {
    const items = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));
    collectionCache.set(cacheKey, { items, fetchedAt: Date.now() });
    return items;
  });

  collectionCache.set(cacheKey, { ...cached, promise: request });
  try {
    return await request;
  } finally {
    const current = collectionCache.get(cacheKey);
    if (current?.promise === request) {
      collectionCache.delete(cacheKey);
    }
  }
}

export function getCollection(collectionName, options) {
  return getCachedDocuments(collectionName, [], options);
}

export function getReferrals(options) {
  return getCachedDocuments("referrals", [], options);
}

export function invalidateCollection(collectionName) {
  for (const cacheKey of collectionCache.keys()) {
    if (cacheKey.startsWith(`${collectionName}:`)) {
      collectionCache.delete(cacheKey);
    }
  }
}

export async function getDocument(
  collectionName,
  documentId,
  { force = false } = {},
) {
  if (!db) throw new Error("Firebase is not configured.");

  const cacheKey = `${collectionName}/${documentId}`;
  const cached = documentCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  if (!force && cached?.promise) return cached.promise;

  const request = getDoc(doc(db, collectionName, documentId)).then(
    (snapshot) => {
      const data = snapshot.exists()
        ? { id: snapshot.id, ...snapshot.data() }
        : null;
      documentCache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    },
  );

  documentCache.set(cacheKey, { ...cached, promise: request });
  try {
    return await request;
  } finally {
    const current = documentCache.get(cacheKey);
    if (current?.promise === request) documentCache.delete(cacheKey);
  }
}

function invalidateDocument(collectionName, documentId) {
  documentCache.delete(`${collectionName}/${documentId}`);
}

export function subscribeToReferrals(
  { status, doctorId, assignedTo },
  onData,
  onError,
) {
  if (!db) {
    onError?.(new Error("Firebase is not configured."));
    return () => {};
  }

  const constraints = [];
  if (status) constraints.push(where("status", "==", status));
  if (doctorId) constraints.push(where("signedByDoctorId", "==", doctorId));
  if (assignedTo) constraints.push(where("assignedTo", "==", assignedTo));

  return onSnapshot(
    query(collection(db, "referrals"), ...constraints),
    (snapshot) =>
      onData(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
    onError,
  );
}

export function subscribeToReferral(referralId, onData, onError) {
  if (!db || !referralId) {
    onError?.(new Error("A Firebase referral id is required."));
    return () => {};
  }

  return onSnapshot(
    doc(db, "referrals", referralId),
    (snapshot) =>
      onData(
        snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null,
      ),
    onError,
  );
}

export function updateReferral(referralId, changes) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return updateDoc(doc(db, "referrals", referralId), changes).then(() => {
    invalidateCollection("referrals");
  });
}

/**
 * Updates many referrals safely, re-validating each one against its
 * *current* server state inside a transaction.
 *
 * `buildChanges(freshReferral)` must return the changes to write, or throw
 * to skip that referral (e.g. another doctor already signed it). A skipped
 * referral never blocks the others.
 *
 * Referrals are processed in chunks of `chunkSize`; each chunk commits
 * atomically. Firestore caps a transaction at 500 writes / 10 MiB.
 *
 * Resolves to { applied: [{ id, changes }], skipped: [{ id, reason }] }.
 * If a chunk fails outright, the thrown error carries `applied` and
 * `skipped` for the chunks that already committed.
 */
export async function updateReferralsTransaction(
  referralIds,
  buildChanges,
  { chunkSize = 100 } = {},
) {
  if (!db) throw new Error("Firebase is not configured.");

  const ids = [...new Set(referralIds)];
  const size = Math.max(1, Math.min(chunkSize, 400));
  const applied = [];
  const skipped = [];

  try {
    for (let start = 0; start < ids.length; start += size) {
      const chunk = ids.slice(start, start + size);
      // The transaction callback may re-run on contention, so it must only
      // build local results; they're merged after a successful commit.
      const result = await runTransaction(db, async (transaction) => {
        const snapshots = await Promise.all(
          chunk.map((id) => transaction.get(doc(db, "referrals", id))),
        );
        const chunkApplied = [];
        const chunkSkipped = [];

        snapshots.forEach((snapshot, index) => {
          const id = chunk[index];
          if (!snapshot.exists()) {
            chunkSkipped.push({
              id,
              reason: "This referral no longer exists.",
            });
            return;
          }
          try {
            const changes = buildChanges({ id, ...snapshot.data() });
            transaction.update(snapshot.ref, changes);
            chunkApplied.push({ id, changes });
          } catch (validationError) {
            chunkSkipped.push({ id, reason: validationError.message });
          }
        });

        return { applied: chunkApplied, skipped: chunkSkipped };
      });
      applied.push(...result.applied);
      skipped.push(...result.skipped);
    }
  } catch (error) {
    error.applied = applied;
    error.skipped = skipped;
    throw error;
  } finally {
    invalidateCollection("referrals");
  }

  return { applied, skipped };
}

export async function completeReferral(referralId) {
  if (!db) throw new Error("Firebase is not configured.");

  const batch = writeBatch(db);
  batch.delete(doc(db, "referrals", referralId));
  batch.set(
    doc(db, "metrics", "summary"),
    { completedCount: increment(1) },
    { merge: true },
  );
  await batch.commit();
  invalidateCollection("referrals");
  invalidateDocument("metrics", "summary");
}

/**
 * Permanently deletes every document in the "referrals" collection.
 *
 * Works in batches of 450 (under Firestore's 500-write batch limit) and
 * re-queries until the collection is empty, so it is safe to retry if it
 * fails partway. `onProgress(deletedSoFar)` is called after each batch.
 * Resolves to the total number of documents deleted.
 *
 * Only removes Firestore documents; it does not touch files in Firebase
 * Storage, and it does not change the `metrics/summary` counters.
 */
export async function deleteAllReferrals({ onProgress } = {}) {
  if (!db) throw new Error("Firebase is not configured.");

  const BATCH_SIZE = 450;
  let deleted = 0;
  try {
    for (;;) {
      const snapshot = await getDocs(
        query(collection(db, "referrals"), limit(BATCH_SIZE)),
      );
      if (snapshot.empty) break;
      const batch = writeBatch(db);
      snapshot.docs.forEach((item) => batch.delete(item.ref));
      await batch.commit();
      deleted += snapshot.size;
      onProgress?.(deleted);
    }
  } finally {
    invalidateCollection("referrals");
  }
  return deleted;
}

export function subscribeToCollection(collectionName, onData, onError) {
  if (!db) {
    onError?.(new Error("Firebase is not configured."));
    return () => {};
  }

  return onSnapshot(
    collection(db, collectionName),
    (snapshot) =>
      onData(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
    onError,
  );
}

export function createDocument(collectionName, data) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return addDoc(collection(db, collectionName), data).then((result) => {
    invalidateCollection(collectionName);
    return result;
  });
}

export function updateDocument(collectionName, documentId, changes) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return updateDoc(doc(db, collectionName, documentId), changes).then(() => {
    invalidateCollection(collectionName);
  });
}

export function deleteDocument(collectionName, documentId) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return deleteDoc(doc(db, collectionName, documentId)).then(() => {
    invalidateCollection(collectionName);
  });
}

export async function updateDocuments(collectionName, documentIds, changes) {
  if (!db) throw new Error("Firebase is not configured.");
  for (let start = 0; start < documentIds.length; start += 450) {
    const batch = writeBatch(db);
    documentIds.slice(start, start + 450).forEach((documentId) => {
      batch.update(doc(db, collectionName, documentId), changes);
    });
    await batch.commit();
  }
  invalidateCollection(collectionName);
}

export async function createDocuments(collectionName, documents) {
  if (!db) throw new Error("Firebase is not configured.");
  for (let start = 0; start < documents.length; start += 450) {
    const batch = writeBatch(db);
    documents.slice(start, start + 450).forEach((data) => {
      batch.set(doc(collection(db, collectionName)), data);
    });
    await batch.commit();
  }
  invalidateCollection(collectionName);
}
