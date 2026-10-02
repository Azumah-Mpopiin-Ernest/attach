import { Zip, ZipPassThrough } from "fflate";
import { jsPDF } from "jspdf";
import { compareDateKeys, getDateKey } from "./referralDates";
import {
  FORM_ASPECT,
  renderReferralFormCanvas,
  renderReferralFormPngBytes,
} from "./referralForm";

// Bulk downloads of referral forms, as ZIPs:
//   downloadAllReferralImagesZip  every referral as its own PNG
//   downloadPrintSheetsZip        A4 print sheets, 4 forms per sheet, as PDFs
//
// The form design itself lives in ONE place: referralForm.js
// (renderReferralFormCanvas). This module only handles bulk delivery, so
// every form here is identical to the officer's single download.
//
// Built for thousands of forms without freezing the tab:
// - forms are rendered one after another (a few at a time for PNGs) and the
//   browser gets a turn after each one, so the page stays responsive;
// - images are encoded with the asynchronous canvas.toBlob, not toDataURL;
// - the archive is streamed straight to a file on disk where the browser
//   supports it, so memory stays flat instead of growing with the export.
//   Elsewhere it is split into several smaller ZIP downloads.
// Entries are stored, not deflated: PNG, JPEG and these PDFs are already
// compressed.

const DEFAULT_CONCURRENCY = 4;
// Only used by the fallback path (no File System Access API): the export is
// split into several ZIPs of this many images so no single archive has to fit
// in memory.
const FALLBACK_PART_SIZE = 500;

function abortError() {
  return new DOMException("Export cancelled.", "AbortError");
}

// Gives the browser a turn (input, painting) between forms. A MessageChannel
// task, unlike setTimeout, is not slowed down when the tab is in the background.
function yieldToBrowser() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image."))),
      type,
      quality,
    ),
  );
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

// Renders `items` ({ data, name, id }) with a small worker pool and streams
// them into a ZIP whose bytes are handed to `sink.write`. Resolves to the
// list of items that failed to render; a failed item never aborts the export.
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
      const { data, name, id } = items[index];

      let bytes = null;
      try {
        bytes = await render(data);
      } catch (renderError) {
        if (renderError?.name === "AbortError") throw renderError;
        failed.push({ id, reason: renderError.message });
      }
      if (bytes) {
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(bytes, true);
      }
      onItem?.(Boolean(bytes));
      await chain; // wait for the disk/memory sink before taking more work
      await yieldToBrowser();
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

// Opens the "save as" dialog. MUST be called synchronously from the click
// handler, before anything is awaited: the dialog needs the click's user
// activation. Resolves to a file handle, or null where the browser cannot
// stream to disk (then the export falls back to ZIP downloads).
function pickZipFile(baseName) {
  const picker =
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
  if (!picker) return Promise.resolve(null);
  return picker.catch((pickerError) => {
    if (pickerError?.name === "AbortError") throw pickerError; // user cancelled
    return null; // e.g. blocked in an iframe: use the fallback
  });
}

// Writes `items` into a ZIP: streamed into the chosen file, or as one or
// more downloaded ZIPs of at most `partSize` items each.
async function deliverZip({
  fileHandle,
  baseName,
  items,
  render,
  concurrency,
  partSize,
  signal,
  onItem,
}) {
  const total = items.length;
  const options = { render, concurrency, signal, onItem };
  const failed = [];

  if (fileHandle) {
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
    return { written: total - failed.length, failed, parts: 1, method: "file" };
  }

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
  return { written: total - failed.length, failed, parts, method: "downloads" };
}

/**
 * Downloads every referral as an individual PNG inside one ZIP.
 *
 * IMPORTANT: call this synchronously from a click handler (see pickZipFile).
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
  const handlePromise = pickZipFile(baseName); // before any await
  const fileHandle = await handlePromise;

  onProgress?.({ phase: "loading", done: 0, total: 0, failed: 0 });
  const referrals = providedReferrals ?? (await loadReferrals?.()) ?? [];
  if (!referrals.length) throw new Error("There are no referrals to export.");
  if (signal?.aborted) throw abortError();

  const used = new Set();
  const items = referrals.map((referral) => ({
    data: referral,
    id: referral.id,
    name: uniqueEntryName(referral, used),
  }));

  const total = items.length;
  let done = 0;
  let failedCount = 0;
  onProgress?.({ phase: "rendering", done: 0, total, failed: 0 });

  return deliverZip({
    fileHandle,
    baseName,
    items,
    render: renderForm,
    concurrency,
    partSize,
    signal,
    onItem: (ok) => {
      done += 1;
      if (!ok) failedCount += 1;
      onProgress?.({ phase: "rendering", done, total, failed: failedCount });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Print sheets: A4 landscape, 4 forms per sheet, in PDFs of 25 sheets
 * ------------------------------------------------------------------ */

const A4_WIDTH_MM = 297;
const A4_HEIGHT_MM = 210;
const PAGE_MARGIN_MM = 6;
const CUT_GUTTER_MM = 4;
const FORMS_PER_SHEET = 4;
// 100 forms per PDF: few files to print, each small enough to build in memory.
const SHEETS_PER_PDF = 25;
// Fallback path only: PDFs per downloaded ZIP (500 forms).
const PDFS_PER_FALLBACK_ZIP = 5;

function drawCutGuides(pdf) {
  pdf.setDrawColor(190);
  pdf.setLineWidth(0.2);
  pdf.setLineDashPattern([1.5, 1.5], 0);
  const midX = A4_WIDTH_MM / 2;
  const midY = A4_HEIGHT_MM / 2;
  pdf.line(midX, PAGE_MARGIN_MM / 2, midX, A4_HEIGHT_MM - PAGE_MARGIN_MM / 2);
  pdf.line(PAGE_MARGIN_MM / 2, midY, A4_WIDTH_MM - PAGE_MARGIN_MM / 2, midY);
  pdf.setLineDashPattern([], 0);
}

// Where form number `position` (0-3) goes on a sheet, keeping the form's shape.
function cellFor(position) {
  const usableWidth = A4_WIDTH_MM - PAGE_MARGIN_MM * 2 - CUT_GUTTER_MM;
  const usableHeight = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2 - CUT_GUTTER_MM;
  const cellWidth = usableWidth / 2;
  const cellHeight = usableHeight / 2;
  const col = position % 2;
  const row = Math.floor(position / 2);
  const cellX = PAGE_MARGIN_MM + col * (cellWidth + CUT_GUTTER_MM);
  const cellY = PAGE_MARGIN_MM + row * (cellHeight + CUT_GUTTER_MM);
  let width = cellWidth;
  let height = width / FORM_ASPECT;
  if (height > cellHeight) {
    height = cellHeight;
    width = height * FORM_ASPECT;
  }
  return {
    x: cellX + (cellWidth - width) / 2,
    y: cellY + (cellHeight - height) / 2,
    width,
    height,
  };
}

// One PDF of up to SHEETS_PER_PDF sheets, rendered one form at a time. A form
// that fails to render leaves its cell empty and is reported, never aborting.
async function buildPrintPdf(referrals, { signal, onForm }) {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  for (let i = 0; i < referrals.length; i += 1) {
    if (signal?.aborted) throw abortError();
    const position = i % FORMS_PER_SHEET;
    if (position === 0) {
      if (i > 0) pdf.addPage();
      drawCutGuides(pdf);
    }
    let ok = false;
    const canvas = await renderReferralFormCanvas(referrals[i]).catch(
      () => null,
    );
    if (canvas) {
      try {
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
        const jpeg = new Uint8Array(await blob.arrayBuffer());
        const { x, y, width, height } = cellFor(position);
        pdf.addImage(jpeg, "JPEG", x, y, width, height, undefined, "FAST");
        ok = true;
      } catch {
        /* reported below */
      } finally {
        canvas.width = 0; // release the bitmap right away
        canvas.height = 0;
      }
    }
    onForm?.(ok, referrals[i]);
    await yieldToBrowser();
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}

/**
 * Downloads print-ready A4 sheets (4 forms per sheet, oldest form date first)
 * as PDFs of up to 100 forms each, inside one ZIP.
 *
 * IMPORTANT: call this synchronously from a click handler (see pickZipFile).
 *
 * Options: loadReferrals, signal, onProgress ({ phase, done, total, failed }).
 * Resolves to { forms, failed, pdfs, parts, method }.
 */
export async function downloadPrintSheetsZip({
  loadReferrals,
  signal,
  onProgress,
} = {}) {
  const baseName = `referral-print-sheets-${new Date().toISOString().slice(0, 10)}`;
  const handlePromise = pickZipFile(baseName); // before any await
  const fileHandle = await handlePromise;

  onProgress?.({ phase: "loading", done: 0, total: 0, failed: 0 });
  const referrals = [...((await loadReferrals?.()) ?? [])].sort((a, b) =>
    compareDateKeys(getDateKey(a), getDateKey(b)),
  );
  if (!referrals.length) throw new Error("No ready or assigned referrals to print.");
  if (signal?.aborted) throw abortError();

  const perPdf = FORMS_PER_SHEET * SHEETS_PER_PDF;
  const items = [];
  for (let i = 0; i < referrals.length; i += perPdf) {
    const number = String(items.length + 1).padStart(3, "0");
    items.push({
      data: referrals.slice(i, i + perPdf),
      id: `pdf-${number}`,
      name: `print-sheets/print-sheets-${number}.pdf`,
    });
  }

  const total = referrals.length;
  let done = 0;
  const failed = [];
  onProgress?.({ phase: "rendering", done: 0, total, failed: 0 });

  const result = await deliverZip({
    fileHandle,
    baseName,
    items,
    render: (group) =>
      buildPrintPdf(group, {
        signal,
        onForm: (ok, referral) => {
          done += 1;
          if (!ok) failed.push({ id: referral.id, reason: "render failed" });
          onProgress?.({ phase: "rendering", done, total, failed: failed.length });
        },
      }),
    concurrency: 1,
    partSize: PDFS_PER_FALLBACK_ZIP,
    signal,
  });
  return {
    forms: total - failed.length,
    failed,
    pdfs: items.length,
    parts: result.parts,
    method: result.method,
  };
}
