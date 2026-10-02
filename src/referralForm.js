import hospitalLogo from "../hfch-logo.png?inline";
import { getSignatureImage } from "./firebaseData";

const FORM_WIDTH = 1600;
const FORM_HEIGHT = 1067;
export const FORM_ASPECT = FORM_WIDTH / FORM_HEIGHT; // ~1.4995

// --- Single-form render ---
// THIS IS THE ONLY DEFINITION OF THE REFERRAL FORM DESIGN. Every download in
// the system (officer single JPEG, admin print-sheet PDFs, admin PNG ZIP)
// goes through this function, so the form looks identical everywhere.
//
// `requireSignatures`: when true, throws if a doctor's signature image is
// referenced but can't be loaded (e.g. offline and not cached), instead of
// silently rendering a blank signature line.
export async function renderReferralFormCanvas(
  referral,
  { requireSignatures = false } = {},
) {
  const canvas = document.createElement("canvas");
  canvas.width = FORM_WIDTH;
  canvas.height = FORM_HEIGHT;
  const context = canvas.getContext("2d");

  context.fillStyle = "#fffdf7";
  context.fillRect(0, 0, FORM_WIDTH, FORM_HEIGHT);
  context.strokeStyle = "#3d4547";
  context.lineWidth = 3;
  context.strokeRect(38, 38, FORM_WIDTH - 76, FORM_HEIGHT - 76);
  context.strokeRect(62, 62, FORM_WIDTH - 124, FORM_HEIGHT - 124);

  const logo = await loadImage(hospitalLogo);

  const titleFont = "bold 43px Arial, sans-serif";
  context.font = titleFont;
  const titleWidth = context.measureText("HOLY FAMILY HOSPITAL, BEREKUM").width;
  const titleCenterX = 850;
  const titleLeftEdge = titleCenterX - titleWidth / 2;

  const logoSize = 100;
  const logoGap = 16;
  const logoX = titleLeftEdge - logoSize - logoGap;
  const logoY = 96;
  if (logo) context.drawImage(logo, logoX, logoY, logoSize, logoSize);

  context.textAlign = "center";
  context.fillStyle = "#1f2527";
  context.font = titleFont;
  context.fillText("HOLY FAMILY HOSPITAL, BEREKUM", titleCenterX, 115);
  context.font = "bold 38px Arial, sans-serif";
  context.fillText("INTERNAL REFERRAL FORM", titleCenterX, 168);
  context.beginPath();
  context.moveTo(470, 188);
  context.lineTo(1230, 188);
  context.stroke();

  const leftX = 120;
  const rightX = 870;
  const rightLineEnd = 1510;
  const row = (label, value, x, y, end) => {
    context.textAlign = "left";
    context.fillStyle = "#343b3d";
    context.font = "31px Arial, sans-serif";
    context.fillText(label, x, y);
    const labelWidth = context.measureText(label).width + 18;
    context.strokeStyle = "#73797a";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x + labelWidth, y + 7);
    context.lineTo(end, y + 7);
    context.stroke();
    if (value) {
      context.fillStyle = "#253d98";
      const valueX = x + labelWidth + 10;
      const availableWidth = Math.max(20, end - valueX - 8);
      context.font = inkFontFor(String(value), availableWidth);
      context.fillText(String(value), valueX, y + 4, availableWidth);
    }
  };

  row("Patient Name:", nameOf(referral), leftX, 310, 760);
  row("MEMBER #:", referral.nhiaNo ?? referral.nhis, 980, 245, rightLineEnd);
  row("LHIMS #:", referral.patientId, 980, 310, rightLineEnd);
  row("Referral From:", referral.referralFrom ?? "OPD", leftX, 415, 760);
  row(
    "Referral To:",
    referral.referralTo ?? "Internal Medicine",
    rightX,
    415,
    rightLineEnd,
  );
  row("Doctor:", referral.referredFromDoctorName, leftX, 520, 760);
  row("Doctor:", referral.referredToDoctorName, rightX, 520, rightLineEnd);
  row("Signature:", "", leftX, 625, 760);
  row("Signature:", "", rightX, 625, rightLineEnd);
  row("Date:", formatDate(referral.referralDate), leftX, 735, 760);
  row("Date:", formatDate(referral.referralDate), rightX, 735, rightLineEnd);

  const [fromSignature, toSignature] = await Promise.all([
    signatureSource(
      referral.referredFromSignatureUrl,
      referral.referredFromSignatureId,
    ),
    signatureSource(
      referral.referredToSignatureUrl,
      referral.referredToSignatureId,
    ),
  ]);
  if (
    requireSignatures &&
    ((referral.referredFromSignatureId && !fromSignature) ||
      (referral.referredToSignatureId && !toSignature))
  ) {
    throw signatureUnavailable();
  }

  await drawSignature(
    context,
    fromSignature,
    285,
    550,
    300,
    85,
    requireSignatures,
  );
  await drawSignature(
    context,
    toSignature,
    1035,
    550,
    300,
    85,
    requireSignatures,
  );

  return canvas;
}

// --- PNG bytes of the same form (used by the admin "Download all forms" ZIP) ---
export async function renderReferralFormPngBytes(referral) {
  const canvas = await renderReferralFormCanvas(referral);
  try {
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not encode image."))),
        "image/png",
      ),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Release the bitmap right away (matters on Safari and big batches).
    canvas.width = 0;
    canvas.height = 0;
  }
}

// File name of the officer's JPEG (download and drag test).
export function referralFormFileName(referral) {
  return `${safeFileName(nameOf(referral))}.jpg`;
}

// --- Officer form as a JPEG blob (used by the download and the drag test) ---
// Requires signatures: officers may be offline, and a JPEG with blank
// signature lines must never be attached to LHIMS by mistake.
export async function renderReferralFormJpegBlob(referral) {
  const canvas = await renderReferralFormCanvas(referral, {
    requireSignatures: true,
  });
  try {
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) throw new Error("Could not create the referral JPEG.");
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

// --- Single-form download (used by OfficerApp) ---
export async function downloadReferralForm(referral) {
  const blob = await renderReferralFormJpegBlob(referral);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = referralFormFileName(referral);
  anchor.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const INK_FONT_FAMILY = "Arial, Helvetica, sans-serif";
const measureContext = document.createElement("canvas").getContext("2d");

function inkFontFor(value, maxWidth) {
  const fontSizes = [40, 38, 36, 34, 32, 30, 28, 26];
  for (const size of fontSizes) {
    const font = `bold ${size}px ${INK_FONT_FAMILY}`;
    measureContext.font = font;
    if (measureContext.measureText(value).width <= maxWidth) return font;
  }
  return `bold 24px ${INK_FONT_FAMILY}`;
}

function nameOf(referral) {
  return (
    referral.name ?? referral.patientName ?? referral.patientId ?? "referral"
  );
}

function formatDate(value) {
  if (!value) return "";
  const date = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB");
}

function safeFileName(value) {
  return (
    String(value)
      .trim()
      .replace(/[<>:"/\\|?*]+/g, " ")
      .replace(/\s+/g, " ") || "referral"
  );
}

// Every referral signed by the same doctor shares one signature image (and
// every form shares the logo), so each distinct URL is loaded and decoded
// once instead of once per form. A failed load is not cached, so a transient
// network error doesn't stick for the rest of the session.
const imageCache = new Map();

const SIGNATURE_UNAVAILABLE =
  "A doctor's signature couldn't be loaded, so the form was not downloaded. Connect to the internet once so signatures are saved on this device, then try again.";

// Signature id -> its image, looked up once per session. A failed or empty
// lookup is not cached, so it is retried next time.
const signatureCache = new Map();
let lastSignatureError = null; // why the most recent signature lookup failed

// Says why a doctor's signature could not be loaded, as precisely as known.
function signatureUnavailable() {
  if (lastSignatureError?.quotaExceeded)
    return new Error(
      "A doctor's signature couldn't be loaded because Firebase's free daily limit is used up. It resets each day (midnight Pacific time, early morning in Ghana); forms whose signatures were already loaded on this device keep working.",
    );
  return new Error(
    lastSignatureError
      ? `${SIGNATURE_UNAVAILABLE} (${lastSignatureError.message})`
      : SIGNATURE_UNAVAILABLE,
  );
}

// Newer referrals point at a signature document (`id`); older ones carry the
// image inline (`url`).
function signatureSource(url, id) {
  if (url) return Promise.resolve(url);
  if (!id) return Promise.resolve(null);
  if (!signatureCache.has(id)) {
    signatureCache.set(
      id,
      getSignatureImage(id)
        .catch((error) => {
          lastSignatureError = error;
          return null;
        })
        .then((source) => {
          if (!source) signatureCache.delete(id);
          return source;
        }),
    );
  }
  return signatureCache.get(id);
}

// Loads a signature while online so it is cached for offline form downloads.
export function prefetchSignature(id) {
  return signatureSource(null, id);
}

function loadImage(source) {
  if (!source) return Promise.resolve(null);
  if (!imageCache.has(source)) {
    imageCache.set(
      source,
      new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => {
          imageCache.delete(source);
          resolve(null);
        };
        image.src = source;
      }),
    );
  }
  return imageCache.get(source);
}

async function drawSignature(
  context,
  source,
  x,
  y,
  width,
  height,
  required = false,
) {
  if (!source) return;
  const image = await loadImage(source);
  if (!image) {
    if (required) {
      throw new Error(SIGNATURE_UNAVAILABLE);
    }
    return;
  }

  const signatureCanvas = inkedSignature(image);
  if (!signatureCanvas) return;
  const crop = signatureCanvas;
  const scale = Math.min(width / crop.width, height / crop.height);
  const drawWidth = crop.width * scale;
  const drawHeight = crop.height * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const { angleDeg, offsetX, offsetY } = seededJitter(source);
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  context.save();
  context.translate(centerX, centerY);
  context.rotate((angleDeg * Math.PI) / 180);
  context.translate(-centerX + offsetX, -centerY + offsetY);

  context.globalAlpha = 1;
  context.drawImage(
    signatureCanvas,
    0,
    0,
    crop.width,
    crop.height,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );
  context.globalAlpha = 0.55;
  context.drawImage(
    signatureCanvas,
    0,
    0,
    crop.width,
    crop.height,
    drawX + 0.6,
    drawY + 0.3,
    drawWidth,
    drawHeight,
  );
  context.globalAlpha = 1;
  context.restore();
  // signatureCanvas is shared by every form with this signature (see
  // inkedSignature): never free or resize it here.
}

// The cropped, ink-coloured signature depends only on the image, so it is
// made once per image and reused for every form (bulk exports draw the same
// few signatures thousands of times).
const inkedCache = new WeakMap();
function inkedSignature(image) {
  if (inkedCache.has(image)) return inkedCache.get(image);
  const crop = opaqueBounds(image);
  let canvas = null;
  if (crop) {
    canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#253d98";
    ctx.fillRect(0, 0, crop.width, crop.height);
  }
  inkedCache.set(image, canvas);
  return canvas;
}

// Hashing a whole inline image (up to ~700 KB) for every form adds up, so the
// result is remembered per source.
const jitterCache = new Map();
function seededJitter(source) {
  if (!jitterCache.has(source)) jitterCache.set(source, computeJitter(source));
  return jitterCache.get(source);
}

function computeJitter(source) {
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const a = (Math.abs(hash) % 1000) / 1000;
  const b = (Math.abs(hash >> 8) % 1000) / 1000;
  const c = (Math.abs(hash >> 16) % 1000) / 1000;
  return {
    angleDeg: (a - 0.5) * 5,
    offsetX: (b - 0.5) * 4,
    offsetY: (c - 0.5) * 3,
  };
}

// The opaque-pixel scan is the slowest part of drawing a signature, and the
// result only depends on the image, so compute it once per image.
const boundsCache = new WeakMap();

function opaqueBounds(image) {
  if (boundsCache.has(image)) return boundsCache.get(image);
  const bounds = computeOpaqueBounds(image);
  boundsCache.set(image, bounds);
  return bounds;
}

function computeOpaqueBounds(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width,
    top = canvas.height,
    right = 0,
    bottom = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (pixels[(y * canvas.width + x) * 4 + 3] > 18) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right <= left || bottom <= top) return null;

  const pad = 2;
  return {
    x: Math.max(0, left - pad),
    y: Math.max(0, top - pad),
    width:
      Math.min(canvas.width - 1, right + pad) - Math.max(0, left - pad) + 1,
    height:
      Math.min(canvas.height - 1, bottom + pad) - Math.max(0, top - pad) + 1,
  };
}
