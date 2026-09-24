import { Zip, ZipPassThrough } from "fflate";
import { renderReferralFormPngBytes } from "./referralForm";

// Exports every referral as its own PNG inside a single ZIP.
//
// The form design itself lives in ONE place: referralForm.js
// (renderReferralFormCanvas). This module only handles bulk delivery, so
// every form in the ZIP is identical to the officer's single download and
// the admin print sheets.
//
// Built for thousands of forms: images are rendered a few at a time and
// streamed into the archive, and (in browsers that support it) the archive is
// streamed straight to a file on disk, so memory stays flat instead of
// growing with the number of forms. PNGs are already compressed, so entries
// are stored rather than deflated again.
//
//   npm install fflate

const DEFAULT_CONCURRENCY = 4;
// Only used by the fallback path (no File System Access API): the export is
// split into several ZIPs of this many images so no single archive has to fit
// in memory.
const FALLBACK_PART_SIZE = 500;

function abortError() {
  return new DOMException("Export cancelled.", "AbortError");
}

/* ------------------------------------------------------------------ *
 * ZIP building
 * ------------------------------------------------------------------ */

function safeSegment(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function uniqueEntryName(referral, used) {
  const base =
    [
      safeSegment(referral.patientId),
      safeSegment(referral.name ?? referral.patientName),
    ]
      .filter(Boolean)
      .join("_") ||
    safeSegment(referral.id) ||
    "referral";
  let name = `referral-forms/${base}.png`;
  let counter = 2;
  while (used.has(name)) name = `referral-forms/${base}_${counter++}.png`;
  used.add(name);
  return name;
}

// Renders `items` with a small worker pool and streams them into a ZIP whose
// bytes are handed to `sink.write`. Resolves to the list of items that
// failed to render; a failed image never aborts the export.
async function buildZip(items, sink, { render, concurrency, signal, onItem }) {
  let chain = Promise.resolve(); // serialises writes and applies backpressure
  let zipError = null;
  let resolveFinal;
  let rejectFinal;
  const finalWritten = new Promise((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  finalWritten.catch(() => {});

  const zip = new Zip((error, chunk, final) => {
    if (error) {
      zipError = error;
      rejectFinal(error);
      return;
    }
    chain = chain.then(() => sink.write(chunk));
    chain.catch(() => {});
    if (final) chain.then(resolveFinal, rejectFinal);
  });

  const failed = [];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (zipError) throw zipError;
      const index = cursor++;
      if (index >= items.length) return;
      const { referral, name } = items[index];

      let bytes = null;
      try {
        bytes = await render(referral);
      } catch (renderError) {
        failed.push({ id: referral.id, reason: renderError.message });
      }
      if (bytes) {
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(bytes, true);
      }
      onItem?.(Boolean(bytes));
      await chain; // wait for the disk/memory sink before taking more work
    }
  };

  try {
    const workers = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
    zip.end();
    await finalWritten;
  } catch (error) {
    zip.terminate();
    throw error;
  }
  return failed;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads every referral as an individual PNG inside one ZIP.
 *
 * IMPORTANT: call this synchronously from a click handler. The browser's
 * "save as" dialog needs the click's user activation, so it is opened before
 * anything else is awaited.
 *
 * Options:
 *   loadReferrals  () => Promise<referral[]>   (or pass `referrals` directly)
 *   renderForm     (referral) => Promise<Uint8Array PNG>; defaults to the
 *                  shared form renderer in referralForm.js. Only override
 *                  this for tests — overriding it makes the exported forms
 *                  differ from every other download in the system.
 *   onProgress     ({ phase: "loading" | "rendering", done, total, failed })
 *   signal         AbortSignal to cancel
 *
 * Resolves to { written, failed, parts, method } where method is "file"
 * (streamed to the chosen file) or "downloads" (browser downloads, split
 * into parts). Rejects with an AbortError if the user cancels.
 */
export async function downloadAllReferralImagesZip({
  loadReferrals,
  referrals: providedReferrals,
  renderForm = renderReferralFormPngBytes,
  concurrency = DEFAULT_CONCURRENCY,
  partSize = FALLBACK_PART_SIZE,
  fileName = "referral-forms",
  signal,
  onProgress,
} = {}) {
  const baseName = `${fileName}-${new Date().toISOString().slice(0, 10)}`;

  // Must be the first thing that happens (before any await).
  const pickerPromise =
    typeof window !== "undefined" &&
    typeof window.showSaveFilePicker === "function"
      ? window.showSaveFilePicker({
          suggestedName: `${baseName}.zip`,
          types: [
            {
              description: "ZIP archive",
              accept: { "application/zip": [".zip"] },
            },
          ],
        })
      : null;

  let fileHandle = null;
  if (pickerPromise) {
    try {
      fileHandle = await pickerPromise;
    } catch (pickerError) {
      if (pickerError?.name === "AbortError") throw pickerError; // user cancelled
      fileHandle = null; // e.g. blocked in an iframe: use the fallback
    }
  }

  onProgress?.({ phase: "loading", done: 0, total: 0, failed: 0 });
  const referrals = providedReferrals ?? (await loadReferrals?.()) ?? [];
  if (!referrals.length) throw new Error("There are no referrals to export.");
  if (signal?.aborted) throw abortError();

  const used = new Set();
  const items = referrals.map((referral) => ({
    referral,
    name: uniqueEntryName(referral, used),
  }));

  const total = items.length;
  let done = 0;
  let failedCount = 0;
  const onItem = (ok) => {
    done += 1;
    if (!ok) failedCount += 1;
    onProgress?.({ phase: "rendering", done, total, failed: failedCount });
  };
  onProgress?.({ phase: "rendering", done: 0, total, failed: 0 });

  const options = { render: renderForm, concurrency, signal, onItem };
  const failed = [];

  if (fileHandle) {
    // Stream straight to disk: memory use does not grow with the archive.
    const writable = await fileHandle.createWritable();
    try {
      failed.push(
        ...(await buildZip(
          items,
          { write: (chunk) => writable.write(chunk) },
          options,
        )),
      );
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {}); // leaves any existing file untouched
      throw error;
    }
    return {
      written: total - failed.length,
      failed,
      parts: 1,
      method: "file",
    };
  }

  // Fallback: several smaller ZIPs, each built in memory and downloaded.
  const parts = Math.ceil(total / partSize);
  for (let part = 0; part < parts; part += 1) {
    const chunks = [];
    const slice = items.slice(part * partSize, (part + 1) * partSize);
    failed.push(
      ...(await buildZip(
        slice,
        { write: async (chunk) => void chunks.push(chunk) },
        options,
      )),
    );
    triggerDownload(
      new Blob(chunks, { type: "application/zip" }),
      parts === 1
        ? `${baseName}.zip`
        : `${baseName}-part-${part + 1}-of-${parts}.zip`,
    );
    if (part < parts - 1) await pause(600); // let the browser accept each download
  }
  return {
    written: total - failed.length,
    failed,
    parts,
    method: "downloads",
  };
}
