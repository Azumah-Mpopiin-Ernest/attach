import {
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";

const CACHE_TTL_MS = 30_000;
const collectionCache = new Map();
const documentCache = new Map();

// On the Spark (free) plan, once the daily Firestore read/write quota is
// exhausted every call fails with this error code. Callers can check
// `error.quotaExceeded` to show something actionable ("try again tomorrow")
// instead of a generic failure message.
function isQuotaExceededError(error) {
  return error?.code === "resource-exhausted";
}

function tagQuotaError(error) {
  if (isQuotaExceededError(error)) error.quotaExceeded = true;
  return error;
}

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

  const request = getDocs(query(collection(db, collectionName), ...constraints))
    .then((snapshot) => {
      const items = snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      }));
      collectionCache.set(cacheKey, { items, fetchedAt: Date.now() });
      return items;
    })
    .catch((error) => {
      throw tagQuotaError(error);
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

  const request = getDoc(doc(db, collectionName, documentId))
    .then((snapshot) => {
      const data = snapshot.exists()
        ? { id: snapshot.id, ...snapshot.data() }
        : null;
      documentCache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    })
    .catch((error) => {
      throw tagQuotaError(error);
    });

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

/**
 * Live-subscribes to referrals matching the given filters.
 *
 * `limitCount`/`orderByField` are optional: pass them for any screen that
 * doesn't need the *entire* matching set (e.g. a recent-activity feed).
 *
 * The doctor pending-signature queue deliberately does NOT pass a limit —
 * it needs every AWAITING_SIGN referral to correctly compute, per doctor,
 * which ones still need a signature from them specifically. Capping that
 * query would hide real pending referrals rather than just save reads.
 * Fixing that properly needs a schema change (a queryable field set at
 * referral-creation time), not a query-time limit.
 */
export function subscribeToReferrals(
  {
    status,
    doctorId,
    assignedTo,
    limitCount,
    orderByField,
    orderByDirection = "asc",
  },
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
  if (orderByField) constraints.push(orderBy(orderByField, orderByDirection));
  if (limitCount) constraints.push(limit(limitCount));

  return onSnapshot(
    query(collection(db, "referrals"), ...constraints),
    (snapshot) =>
      onData(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
    (error) => onError?.(tagQuotaError(error)),
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
    (error) => onError?.(tagQuotaError(error)),
  );
}

/**
 * Cheap count of referrals matching a filter — one server-side read
 * regardless of how many documents match (Firestore aggregation query).
 * Use this instead of getReferrals()/subscribeToReferrals() wherever only
 * a number is needed (badges, dashboard tiles), since those otherwise cost
 * one read per matching document.
 */
export async function getReferralCount({ status, doctorId, assignedTo } = {}) {
  if (!db) throw new Error("Firebase is not configured.");

  const constraints = [];
  if (status) constraints.push(where("status", "==", status));
  if (doctorId) constraints.push(where("signedByDoctorId", "==", doctorId));
  if (assignedTo) constraints.push(where("assignedTo", "==", assignedTo));

  try {
    const snapshot = await getCountFromServer(
      query(collection(db, "referrals"), ...constraints),
    );
    return snapshot.data().count;
  } catch (error) {
    throw tagQuotaError(error);
  }
}

export function updateReferral(referralId, changes) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return updateDoc(doc(db, "referrals", referralId), changes)
    .then(() => {
      invalidateCollection("referrals");
    })
    .catch((error) => {
      throw tagQuotaError(error);
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
 * atomically. Firestore caps a transaction at 500 document writes and
 * 10 MiB total, so chunkSize is capped well under that regardless of what
 * the caller passes.
 *
 * Resolves to { applied: [{ id, changes }], skipped: [{ id, reason }] }.
 * If a chunk fails outright, the thrown error carries `applied` and
 * `skipped` for the chunks that already committed, plus `quotaExceeded`
 * if the failure was the Spark plan's daily quota.
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
    throw tagQuotaError(error);
  } finally {
    invalidateCollection("referrals");
  }

  return { applied, skipped };
}

// metricsDaily/{dateKey} holds one counter per calendar day (client-local
// date, e.g. "2026-09-27"). completeReferral() deletes the referral
// document itself, so this is the only surviving record of *when*
// completions happened — needed for "completed today" and any day-by-day
// dashboard view.
function dateKeyFor(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function completeReferral(referralId) {
  if (!db) throw new Error("Firebase is not configured.");

  const todayKey = dateKeyFor(new Date());
  const batch = writeBatch(db);
  batch.delete(doc(db, "referrals", referralId));
  batch.set(
    doc(db, "metrics", "summary"),
    { completedCount: increment(1) },
    { merge: true },
  );
  batch.set(
    doc(db, "metricsDaily", todayKey),
    { count: increment(1) },
    { merge: true },
  );
  try {
    await batch.commit();
  } catch (error) {
    throw tagQuotaError(error);
  }
  invalidateCollection("referrals");
  invalidateDocument("metrics", "summary");
  invalidateDocument("metricsDaily", todayKey);
}

/**
 * Completed-referral counts for the last `days` calendar days (including
 * today), oldest first: [{ dateKey, date, count }]. Reads one doc per day
 * (cheap, and cached like everything else in this file) rather than a
 * range query, since metricsDaily docs are keyed by date string, not a
 * queryable timestamp field.
 */
export async function getDailyCompletionCounts(days = 7) {
  const today = new Date();
  const keys = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - (days - 1 - index));
    return { date, dateKey: dateKeyFor(date) };
  });

  const results = await Promise.all(
    keys.map(({ dateKey }) => getDocument("metricsDaily", dateKey)),
  );

  return keys.map(({ date, dateKey }, index) => ({
    dateKey,
    date,
    count: results[index]?.count ?? 0,
  }));
}

// meta/currentImportBatch tracks which Excel filenames have already been
// imported for the CURRENT intake batch only. Admin never starts a new
// batch until every referral from the current one has been signed,
// assigned, attached, and cleared from the system — so this deliberately
// does NOT need to remember filenames across batches. finishImportBatch()
// (called by the admin's "Done" action) deletes this doc entirely once
// the batch is finished, so it never grows unbounded and never flags a
// filename from a previous, already-completed batch.
const IMPORT_BATCH_COLLECTION = "meta";
const IMPORT_BATCH_DOC_ID = "currentImportBatch";

/**
 * Filenames already imported in the batch currently in progress (empty
 * array if no batch is in progress, i.e. after "Done" was last clicked).
 */
export async function getImportBatchFileNames(options) {
  const data = await getDocument(
    IMPORT_BATCH_COLLECTION,
    IMPORT_BATCH_DOC_ID,
    options,
  );
  return data?.fileNames ?? [];
}

/**
 * Records that `fileName` was successfully imported as part of the batch
 * in progress. Creates the tracking doc on the first file of a batch.
 */
export async function markFileImported(fileName) {
  if (!db) throw new Error("Firebase is not configured.");
  try {
    await setDoc(
      doc(db, IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID),
      { fileNames: arrayUnion(fileName) },
      { merge: true },
    );
  } catch (error) {
    throw tagQuotaError(error);
  } finally {
    invalidateDocument(IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID);
  }
}

/**
 * Called when admin clicks "Done" after finishing a batch: deletes the
 * tracking doc so the next batch starts with a clean slate. Safe to call
 * even if no tracking doc exists yet.
 */
export async function finishImportBatch() {
  if (!db) throw new Error("Firebase is not configured.");
  try {
    await deleteDoc(doc(db, IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID));
  } catch (error) {
    throw tagQuotaError(error);
  } finally {
    invalidateDocument(IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID);
  }
}

/**
 * Permanently deletes every document in the "referrals" collection.
 * DESTRUCTIVE AND IRREVERSIBLE — requires `{ confirm: true }` so it can't
 * be triggered by an accidental or copy-pasted call.
 *
 * Works in batches of 450 (under Firestore's 500-write batch limit) and
 * re-queries until the collection is empty, so it is safe to retry if it
 * fails partway — pass the same call again and it'll pick up where it left
 * off. `onProgress(deletedSoFar)` is called after each batch. On failure,
 * the thrown error carries `deleted` (how many were removed before the
 * failure) and `quotaExceeded` if that was the cause.
 *
 * Only removes Firestore documents; it does not touch files in Firebase
 * Storage, and it does not change the `metrics/summary` counters.
 */
export async function deleteAllReferrals({ onProgress, confirm } = {}) {
  if (!db) throw new Error("Firebase is not configured.");
  if (confirm !== true) {
    throw new Error(
      "deleteAllReferrals is destructive and irreversible. Call it with { confirm: true } to proceed.",
    );
  }

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
  } catch (error) {
    error.deleted = deleted;
    throw tagQuotaError(error);
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
    (error) => onError?.(tagQuotaError(error)),
  );
}

export function createDocument(collectionName, data) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return addDoc(collection(db, collectionName), data)
    .then((result) => {
      invalidateCollection(collectionName);
      return result;
    })
    .catch((error) => {
      throw tagQuotaError(error);
    });
}

export function updateDocument(collectionName, documentId, changes) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return updateDoc(doc(db, collectionName, documentId), changes)
    .then(() => {
      invalidateCollection(collectionName);
    })
    .catch((error) => {
      throw tagQuotaError(error);
    });
}

export function deleteDocument(collectionName, documentId) {
  if (!db) return Promise.reject(new Error("Firebase is not configured."));
  return deleteDoc(doc(db, collectionName, documentId))
    .then(() => {
      invalidateCollection(collectionName);
    })
    .catch((error) => {
      throw tagQuotaError(error);
    });
}

/**
 * On failure, the thrown error carries `updated` — how many documents had
 * already committed in prior batches — so a caller can decide whether to
 * retry the whole call (batches already applied are idempotent here since
 * every batch writes the same `changes`).
 */
export async function updateDocuments(collectionName, documentIds, changes) {
  if (!db) throw new Error("Firebase is not configured.");
  let updated = 0;
  try {
    for (let start = 0; start < documentIds.length; start += 450) {
      const batch = writeBatch(db);
      const slice = documentIds.slice(start, start + 450);
      slice.forEach((documentId) => {
        batch.update(doc(db, collectionName, documentId), changes);
      });
      await batch.commit();
      updated += slice.length;
    }
  } catch (error) {
    error.updated = updated;
    throw tagQuotaError(error);
  } finally {
    invalidateCollection(collectionName);
  }
}

/**
 * On failure, the thrown error carries `created` — how many documents had
 * already committed in prior batches. Unlike updateDocuments, retrying the
 * full call after a partial failure will create duplicates, since each
 * document gets a fresh auto-generated id; slice `documents` past `created`
 * before retrying.
 */
export async function createDocuments(collectionName, documents) {
  if (!db) throw new Error("Firebase is not configured.");
  let created = 0;
  try {
    for (let start = 0; start < documents.length; start += 450) {
      const batch = writeBatch(db);
      const slice = documents.slice(start, start + 450);
      slice.forEach((data) => {
        batch.set(doc(collection(db, collectionName)), data);
      });
      await batch.commit();
      created += slice.length;
    }
  } catch (error) {
    error.created = created;
    throw tagQuotaError(error);
  } finally {
    invalidateCollection(collectionName);
  }
}
