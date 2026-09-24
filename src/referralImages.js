import { Zip, ZipPassThrough } from "fflate";

// Exports every referral as its own PNG inside a single ZIP.
//
// Built for thousands of forms: images are rendered a few at a time and
// streamed into the archive, and (in browsers that support it) the archive is
// streamed straight to a file on disk, so memory stays flat instead of
// growing with the number of forms. PNGs are already compressed, so entries
// are stored rather than deflated again.
//
//   npm install fflate

const FORM_WIDTH_MM = 150;
const FORM_HEIGHT_MM = 100;
const DEFAULT_DPI = 300;
const DEFAULT_CONCURRENCY = 4;
// Only used by the fallback path (no File System Access API): the export is
// split into several ZIPs of this many images so no single archive has to fit
// in memory.
const FALLBACK_PART_SIZE = 500;

const FONT = "Arial, Helvetica, sans-serif";
const MONO = '"Courier New", Courier, monospace';
const INK = "#0f172a";
const MUTED = "#64748b";
const RULE = "#cbd5e1";

function abortError() {
  return new DOMException("Export cancelled.", "AbortError");
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const imageCache = new Map();

// Every referral signed by the same doctor shares one signature image, so
// decode each distinct URL once instead of thousands of times.
function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (!imageCache.has(url)) {
    imageCache.set(
      url,
      new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous"; // hosted signatures need CORS enabled
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
      }),
    );
  }
  return imageCache.get(url);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number")
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-GB") : "";
}

function fitFont(ctx, text, weight, family, size, minSize, maxWidth) {
  let current = size;
  ctx.font = `${weight} ${current}px ${family}`;
  while (current > minSize && ctx.measureText(text).width > maxWidth) {
    current -= size * 0.04;
    ctx.font = `${weight} ${current}px ${family}`;
  }
  return current;
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

/**
 * Draws one referral onto a 150mm x 100mm landscape canvas and returns PNG
 * bytes. This is a self-contained layout; to match your official form
 * exactly, pass your own `renderForm(referral) => Promise<Uint8Array>` to
 * `downloadAllReferralImagesZip`.
 */
export async function renderReferralFormPng(
  referral,
  { dpi = DEFAULT_DPI } = {},
) {
  const u = dpi / 25.4; // pixels per millimetre
  const m = (mm) => mm * u;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(m(FORM_WIDTH_MM));
  canvas.height = Math.round(m(FORM_HEIGHT_MM));
  const ctx = canvas.getContext("2d");

  const [fromImage, toImage] = await Promise.all([
    loadImage(referral.referredFromSignatureUrl),
    loadImage(referral.referredToSignatureUrl),
  ]);

  const text = (value, x, y, opts = {}) => {
    const {
      size = 3.4,
      weight = "400",
      family = FONT,
      color = INK,
      align = "left",
      maxWidth,
      italic = false,
    } = opts;
    const style = italic ? "italic " : "";
    let px = m(size);
    ctx.font = `${style}${weight} ${px}px ${family}`;
    if (maxWidth) {
      px = fitFont(ctx, value, weight, family, px, m(size * 0.6), m(maxWidth));
      ctx.font = `${style}${weight} ${px}px ${family}`;
    }
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(value, m(x), m(y));
  };

  const rule = (x1, x2, y, color = RULE, width = 0.25) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = m(width);
    ctx.beginPath();
    ctx.moveTo(m(x1), m(y));
    ctx.lineTo(m(x2), m(y));
    ctx.stroke();
  };

  const field = (label, value, x, y, maxWidth, family = FONT) => {
    text(label, x, y, { size: 2.4, color: MUTED });
    text(value || "—", x, y + 5.4, {
      size: 3.9,
      weight: "600",
      family,
      maxWidth,
    });
  };

  const signatureBlock = (title, doctorName, signedAt, image, x) => {
    const areaWidth = 58;
    const areaHeight = 13;
    const baseline = 81.5;
    text(title, x, 64, { size: 2.4, color: MUTED });
    if (image) {
      const scale = Math.min(
        m(areaWidth) / image.width,
        m(areaHeight) / image.height,
      );
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      ctx.drawImage(
        image,
        m(x),
        m(baseline - 0.8) - drawHeight,
        drawWidth,
        drawHeight,
      );
    } else {
      text(doctorName ? "Signature unavailable" : "Awaiting signature", x, 76, {
        size: 3,
        color: MUTED,
        italic: true,
      });
    }
    rule(x, x + areaWidth, baseline, INK, 0.3);
    text(doctorName || "—", x, 86, {
      size: 3.2,
      weight: "600",
      maxWidth: areaWidth,
    });
    const signed = formatDate(signedAt);
    if (signed) text(`Signed ${signed}`, x, 90.3, { size: 2.4, color: MUTED });
  };

  // Page and frame
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = INK;
  ctx.lineWidth = m(0.35);
  ctx.strokeRect(m(4), m(4), m(142), m(92));

  // Header
  text("REFERRAL FORM", 9, 13, { size: 4.4, weight: "700" });
  text(referral.patientId ?? "", 141, 13, {
    size: 3.4,
    family: MONO,
    color: MUTED,
    align: "right",
    maxWidth: 60,
  });
  rule(9, 141, 17.5);

  // Patient details
  field("Patient name", referral.name ?? referral.patientName, 9, 24, 78);
  field("NHIS number", referral.nhis, 95, 24, 46, MONO);
  field("Patient ID", referral.patientId, 9, 37, 78, MONO);
  field("Referral date", formatDate(referral.referralDate), 95, 37, 46);

  // Reason
  text("Reason for referral", 9, 49, { size: 2.4, color: MUTED });
  const reason = referral.reason ?? referral.referralReason ?? "";
  ctx.font = `400 ${m(3.3)}px ${FONT}`;
  wrapLines(ctx, reason || "—", m(132), 3).forEach((line, index) => {
    text(line, 9, 54.5 + index * 4.4, { size: 3.3 });
  });

  // Signatures
  signatureBlock(
    "Referred From",
    referral.referredFromDoctorName,
    referral.referredFromSignedAt,
    fromImage,
    9,
  );
  signatureBlock(
    "Referred To",
    referral.referredToDoctorName,
    referral.referredToSignedAt,
    toImage,
    83,
  );

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (result) =>
        result ? resolve(result) : reject(new Error("Could not encode image.")),
      "image/png",
    ),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  canvas.width = 0; // release the bitmap right away (matters on Safari)
  canvas.height = 0;
  return bytes;
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
 *                  built-in layout above
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
  renderForm,
  dpi = DEFAULT_DPI,
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

  const render =
    renderForm ?? ((referral) => renderReferralFormPng(referral, { dpi }));
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

  const options = { render, concurrency, signal, onItem };
  const failed = [];

  try {
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
  } finally {
    imageCache.clear();
  }
}
