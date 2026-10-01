import { useEffect, useState } from "react";
import {
  downloadReferralForm,
  referralFormFileName,
  renderReferralFormJpegBlob,
} from "../../src/referralForm";

// The "forms folder": a folder the officer picks once. Instead of landing in
// the Downloads folder among everything else, each form is saved here, and
// the app keeps ONLY the current patient's form in it. LHIMS's file picker
// (or a drag from the folder) can then only ever show the right file.
//
// Uses the File System Access API (Chrome and Edge, secure context). Where
// it isn't available, or no folder has been chosen, forms download exactly
// as before.

const DB_NAME = "referral-forms-folder";
const STORE_NAME = "handles";
const FOLDER_KEY = "formsFolder";
const READ_WRITE = { mode: "readwrite" };
// Only form images are ever removed from the folder; anything else is left
// alone.
const FORM_FILE_PATTERN = /\.jpe?g$/i;

export function isFormsFolderSupported() {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );
}

// --- Remembering the chosen folder across visits (IndexedDB) ---------------

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runStoreRequest(mode, makeRequest) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = makeRequest(
        database.transaction(STORE_NAME, mode).objectStore(STORE_NAME),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

const readStoredFolder = () =>
  runStoreRequest("readonly", (store) => store.get(FOLDER_KEY));

const storeFolder = (handle) =>
  runStoreRequest("readwrite", (store) => store.put(handle, FOLDER_KEY));

// --- Folder access ---------------------------------------------------------

// Must be called from a click handler: requestPermission needs a user
// gesture. Resolves true when the folder may be written to.
async function ensureAccess(handle) {
  if ((await handle.queryPermission(READ_WRITE)) === "granted") return true;
  return (await handle.requestPermission(READ_WRITE)) === "granted";
}

async function listEntries(directory) {
  const entries = [];
  for await (const [name, entry] of directory.entries()) {
    entries.push({ name, kind: entry.kind });
  }
  return entries;
}

// Writes `blob` as `fileName` and removes any OTHER form image first, so the
// folder holds exactly one form.
async function writeForm(directory, fileName, blob) {
  const existing = await listEntries(directory);
  for (const { name, kind } of existing) {
    if (kind === "file" && name !== fileName && FORM_FILE_PATTERN.test(name)) {
      await directory.removeEntry(name);
    }
  }

  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (writeError) {
    await writable.abort().catch(() => {});
    throw writeError;
  }
}

/**
 * State and actions for the forms folder.
 *
 *   deliver(referral)    saves the form into the folder (or downloads it
 *                        when no folder is usable). Call from a click.
 *                        Resolves { notice }: non-empty when it had to fall
 *                        back to a normal download. Rejects if the form
 *                        can't be produced (e.g. signatures not cached).
 *   removeForm(referral) deletes that referral's file once it is done or
 *                        skipped. Never prompts, never throws.
 *   chooseFolder()       opens the folder picker (must be empty).
 *   allowAccess()        re-grants access after the browser forgot it.
 */
export function useFormsFolder() {
  const supported = isFormsFolderSupported();
  const [handle, setHandle] = useState(null);
  const [permission, setPermission] = useState("prompt");
  const [loaded, setLoaded] = useState(!supported);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supported) return undefined;
    let active = true;
    readStoredFolder()
      .then(async (stored) => {
        if (!stored) return;
        const state = await stored.queryPermission(READ_WRITE);
        if (!active) return;
        setHandle(stored);
        setPermission(state);
      })
      .catch(() => {
        // The remembered folder is unreadable; the officer can choose again.
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [supported]);

  const chooseFolder = async () => {
    setError("");
    try {
      const picked = await window.showDirectoryPicker({
        id: "referral-forms",
        mode: "readwrite",
      });
      if ((await listEntries(picked)).length > 0) {
        throw new Error(
          "That folder isn't empty. Create a new, empty folder for referral forms and choose it, so nothing else in it is ever changed.",
        );
      }
      await storeFolder(picked).catch(() => {
        // Not remembered across visits, but usable for this session.
      });
      setHandle(picked);
      setPermission("granted");
    } catch (pickError) {
      // AbortError just means the officer closed the picker.
      if (pickError?.name !== "AbortError") setError(pickError.message);
    }
  };

  const allowAccess = async () => {
    if (!handle) return;
    setError("");
    try {
      await ensureAccess(handle);
      setPermission(await handle.queryPermission(READ_WRITE));
    } catch (accessError) {
      setError(accessError.message);
    }
  };

  const deliver = async (referral) => {
    if (!handle) {
      await downloadReferralForm(referral);
      return { notice: "" };
    }

    // First await on purpose: the permission prompt needs the click's user
    // activation, which would lapse if the form were rendered first.
    let granted = false;
    try {
      granted = await ensureAccess(handle);
    } catch {
      granted = false;
    }
    setPermission(granted ? "granted" : "prompt");
    if (!granted) {
      await downloadReferralForm(referral);
      return {
        notice:
          "Access to the forms folder wasn't allowed, so the form went to your Downloads folder instead.",
      };
    }

    // Not caught here: a missing signature must stop the save, not fall
    // back to a download (which would fail the same way).
    const blob = await renderReferralFormJpegBlob(referral);
    try {
      await writeForm(handle, referralFormFileName(referral), blob);
      return { notice: "" };
    } catch {
      await downloadReferralForm(referral);
      return {
        notice:
          "The forms folder couldn't be used (it may have been moved or deleted), so the form went to your Downloads folder instead. Choose the folder again to fix this.",
      };
    }
  };

  const removeForm = async (referral) => {
    if (!handle) return;
    try {
      if ((await handle.queryPermission(READ_WRITE)) !== "granted") return;
      await handle.removeEntry(referralFormFileName(referral));
    } catch {
      // Already gone, or the folder is unavailable. The next save replaces
      // any leftover form anyway.
    }
  };

  return {
    supported,
    loaded,
    hasFolder: Boolean(handle),
    folderName: handle?.name ?? "",
    permission,
    error,
    chooseFolder,
    allowAccess,
    deliver,
    removeForm,
  };
}
