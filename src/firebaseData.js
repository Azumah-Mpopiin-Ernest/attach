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
 *
 * `includeMetadata`: when true, `onData` receives a second argument
 * `{ fromCache, hasPendingWrites }` and also fires when only that metadata
 * changes. The officer screen uses this to detect "answering from the local
 * cache only" (i.e. offline), which `navigator.onLine` can't tell it on a
 * LAN with no internet. Other screens leave it off and are unaffected.
 */
export function subscribeToReferrals(
  {
    status,
    doctorId,
    assignedTo,
    limitCount,
    orderByField,
    orderByDirection = "asc",
    includeMetadata = false,
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
    { includeMetadataChanges: includeMetadata },
    (snapshot) => {
      const items = snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      }));
      if (includeMetadata) {
        onData(items, {
          fromCache: snapshot.metadata.fromCache,
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
        });
      } else {
        onData(items);
      }
    },
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

// ---------------------------------------------------------------------------
// BATCH-SCOPED DATA
//
// Everything below the referrals themselves belongs to the batch currently
// being worked on, and is wiped by resetBatchIfEmpty() the moment the
// referrals collection is empty (i.e. every referral has been signed,
// assigned, attached in LHIMS and marked done):
//
//   meta/currentImportBatch   filenames imported + total rows imported
//   metrics/batchSummary      referrals completed
//   metricsDaily/{dateKey}    completions per calendar day (7-day chart)
//   officerDailyStats/{...}   completions per officer per day
//   officerStats/{name}       completions per officer (batch total)
// ---------------------------------------------------------------------------

const BATCH_COLLECTIONS = [
  "meta",
  "metrics",
  "metricsDaily",
  "officerStats",
  "officerDailyStats",
];

// metricsDaily/{dateKey} holds one counter per calendar day (client-local
// date, e.g. "2026-09-27"). completeReferral() deletes the referral
// document itself, so this is the only surviving record of *when*
// completions happened within the current batch.
function dateKeyFor(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Marks one referral complete. Requires `officerName` (the officer's
 * profile fullName, matching how `assignedTo` is stored on referrals) so
 * this can attribute the completion to them. The referral itself is
 * deleted; the counters written here are the only record of the work, and
 * they all belong to the current batch (see resetBatchIfEmpty).
 *
 * OFFLINE-FRIENDLY: the commit is started immediately and Firestore's local
 * cache applies it at once, so live queries (the officer's queue) update
 * instantly even with no connection. The returned promise settles when the
 * SERVER confirms or rejects the write, which may be much later. Callers
 * that don't want to block the UI on that should not await it (see
 * OfficerApp.markDone). If the server rejects the write, Firestore rolls
 * the local change back and the referral reappears.
 */
export async function completeReferral(referralId, officerName) {
  if (!db) throw new Error("Firebase is not configured.");
  if (!officerName) {
    throw new Error("An officer name is required to complete a referral.");
  }

  const todayKey = dateKeyFor(new Date());
  const officerDailyStatId = `${officerName}_${todayKey}`;

  const batch = writeBatch(db);
  batch.delete(doc(db, "referrals", referralId));
  batch.set(
    doc(db, "metrics", "batchSummary"),
    { completedCount: increment(1) },
    { merge: true },
  );
  batch.set(
    doc(db, "metricsDaily", todayKey),
    { count: increment(1) },
    { merge: true },
  );
  batch.set(
    doc(db, "officerDailyStats", officerDailyStatId),
    { officerName, dateKey: todayKey, count: increment(1) },
    { merge: true },
  );
  batch.set(
    doc(db, "officerStats", officerName),
    { officerName, totalCompleted: increment(1) },
    { merge: true },
  );

  // Start the commit now; don't wait for the server before updating caches.
  const commit = batch.commit();

  invalidateCollection("referrals");
  invalidateDocument("metrics", "batchSummary");
  invalidateDocument("metricsDaily", todayKey);
  invalidateDocument("officerDailyStats", officerDailyStatId);
  invalidateDocument("officerStats", officerName);

  try {
    await commit;
  } catch (error) {
    throw tagQuotaError(error);
  }
}

/**
 * Completed-referral counts for the last `days` calendar days (including
 * today), oldest first: [{ dateKey, date, count }]. Reads one doc per day
 * (cheap, and cached like everything else in this file) rather than a
 * range query, since metricsDaily docs are keyed by date string, not a
 * queryable timestamp field. Only reflects the current batch.
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

/**
 * Per-officer completion counts for the CURRENT batch: today, the last
 * `days` days (default 7), and batch total — sorted by total, descending.
 * Everything here is wiped when the batch closes.
 *
 * "Today"/"week" come from officerDailyStats (one doc per officer per
 * calendar day), queried directly rather than through the generic cache
 * helper since a `where(...,"in",...)` constraint doesn't hash reliably
 * as a cache key. "Total" comes from officerStats.
 */
export async function getOfficerPerformance(days = 7) {
  if (!db) throw new Error("Firebase is not configured.");

  const today = new Date();
  const dateKeys = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - (days - 1 - index));
    return dateKeyFor(date);
  });
  const todayKey = dateKeys[dateKeys.length - 1];

  const [dailySnapshot, officerTotals] = await Promise.all([
    getDocs(
      query(
        collection(db, "officerDailyStats"),
        where("dateKey", "in", dateKeys),
      ),
    ).catch((error) => {
      throw tagQuotaError(error);
    }),
    getCollection("officerStats"),
  ]);

  const byOfficer = new Map();
  const ensure = (officerName) => {
    if (!byOfficer.has(officerName)) {
      byOfficer.set(officerName, {
        officerName,
        today: 0,
        week: 0,
        total: 0,
      });
    }
    return byOfficer.get(officerName);
  };

  dailySnapshot.docs.forEach((snapshot) => {
    const { officerName, dateKey, count } = snapshot.data();
    const entry = ensure(officerName);
    entry.week += count;
    if (dateKey === todayKey) entry.today += count;
  });

  officerTotals.forEach(({ officerName, totalCompleted }) => {
    ensure(officerName).total = totalCompleted ?? 0;
  });

  return Array.from(byOfficer.values()).sort(
    (a, b) => b.total - a.total || a.officerName.localeCompare(b.officerName),
  );
}

/**
 * THE BATCH RESET. If the referrals collection is empty, the current batch
 * is finished: delete every batch-scoped document (imported count, filename
 * list, completed counts, daily counts, officer stats) so the next batch
 * starts from zero.
 *
 * Call this on admin page load (dashboard, intake) and right before an
 * import. Cost when referrals still exist: a single aggregation-count read.
 * Admin-only (the security rules only let admin delete these docs).
 *
 * This also covers deleteAllReferrals(): once that empties the collection,
 * the next call here performs the reset.
 *
 * Resolves to true if it wiped anything, false otherwise.
 */
export async function resetBatchIfEmpty() {
  if (!db) throw new Error("Firebase is not configured.");

  try {
    const countSnapshot = await getCountFromServer(collection(db, "referrals"));
    if (countSnapshot.data().count > 0) return false;

    const snapshots = await Promise.all(
      BATCH_COLLECTIONS.map((name) => getDocs(collection(db, name))),
    );
    const refs = snapshots.flatMap((snapshot) =>
      snapshot.docs.map((item) => item.ref),
    );
    if (!refs.length) return false;

    for (let start = 0; start < refs.length; start += 450) {
      const batch = writeBatch(db);
      refs.slice(start, start + 450).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    return true;
  } catch (error) {
    throw tagQuotaError(error);
  } finally {
    // Whatever happened, cached batch numbers may now be stale.
    collectionCache.clear();
    documentCache.clear();
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
 * Storage. Batch metrics are NOT cleared here directly — but since the
 * collection is now empty, the next admin page load runs
 * resetBatchIfEmpty() and clears them.
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

// meta/currentImportBatch tracks, for the CURRENT batch:
//   fileNames     — filenames imported since admin last clicked "Done" on the
//                   intake page (powers the duplicate-file warning only)
//   importedCount — total referral rows imported so far in the batch
//
// Clicking "Done" on the intake page only clears `fileNames`. The whole doc
// (including importedCount) is deleted by resetBatchIfEmpty() once every
// referral in the batch has been completed.
const IMPORT_BATCH_COLLECTION = "meta";
const IMPORT_BATCH_DOC_ID = "currentImportBatch";

/**
 * Filenames imported since "Done" was last clicked (empty array if none).
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
 * Total referral rows imported so far in the current batch.
 */
export async function getImportBatchImportedCount(options) {
  const data = await getDocument(
    IMPORT_BATCH_COLLECTION,
    IMPORT_BATCH_DOC_ID,
    options,
  );
  return data?.importedCount ?? 0;
}

/**
 * Referrals completed so far in the current batch.
 */
export async function getBatchCompletedCount(options) {
  const data = await getDocument("metrics", "batchSummary", options);
  return data?.completedCount ?? 0;
}

/**
 * Records that `fileName` (containing `importedRowCount` referral rows)
 * was successfully imported as part of the batch in progress. Creates the
 * tracking doc on the first file of a batch.
 */
export async function markFileImported(fileName, importedRowCount = 0) {
  if (!db) throw new Error("Firebase is not configured.");
  try {
    await setDoc(
      doc(db, IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID),
      {
        fileNames: arrayUnion(fileName),
        importedCount: increment(importedRowCount),
      },
      { merge: true },
    );
  } catch (error) {
    throw tagQuotaError(error);
  } finally {
    invalidateDocument(IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID);
  }
}

/**
 * Called when admin clicks "Done" on the intake page — meaning "I'm finished
 * uploading files for now", NOT "the batch is finished". Only clears the
 * filename list used for the duplicate-upload warning. importedCount and all
 * other batch metrics keep running until referrals hit 0.
 */
export async function clearImportBatchFileNames() {
  if (!db) throw new Error("Firebase is not configured.");
  try {
    await setDoc(
      doc(db, IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID),
      { fileNames: [] },
      { merge: true },
    );
  } catch (error) {
    throw tagQuotaError(error);
  } finally {
    invalidateDocument(IMPORT_BATCH_COLLECTION, IMPORT_BATCH_DOC_ID);
  }
}
