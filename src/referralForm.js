import hospitalLogo from "../hfch-logo.png?inline";
import { jsPDF } from "jspdf";
import { getDateKey, compareDateKeys } from "./referralDates";
import JSZip from "jszip";

const FORM_WIDTH = 1600;
const FORM_HEIGHT = 1067;
const FORM_ASPECT = FORM_WIDTH / FORM_HEIGHT; // ~1.4995

// --- Single-form render (unchanged drawing logic, just no longer downloads) ---
export async function renderReferralFormCanvas(referral) {
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

  await drawSignature(
    context,
    referral.referredFromSignatureUrl,
    285,
    550,
    300,
    85,
  );
  await drawSignature(
    context,
    referral.referredToSignatureUrl,
    1035,
    550,
    300,
    85,
  );

  return canvas;
}

// --- Single-form download (used by OfficerApp — unchanged behavior) ---
export async function downloadReferralForm(referral) {
  const canvas = await renderReferralFormCanvas(referral);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Could not create the referral JPEG.");

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(nameOf(referral))}.jpg`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// --- Bulk print sheets: one A4 PDF per 4 forms, delivered as a zip ---
const A4_WIDTH_MM = 297;
const A4_HEIGHT_MM = 210;
const PAGE_MARGIN_MM = 6;
const CUT_GUTTER_MM = 4;
const FORMS_PER_SHEET = 4;

const RENDER_BATCH_SIZE = 40; // ~10 sheets' worth of forms per batch

export async function downloadReadyToAssignFormsZip(
  referrals,
  zipFileName,
  onProgress,
) {
  const sorted = [...referrals].sort((a, b) =>
    compareDateKeys(getDateKey(a), getDateKey(b)),
  );
  if (!sorted.length) throw new Error("No referrals are ready to assign.");

  const zip = new JSZip();
  let sheetIndex = 0;
  let leftover = []; // canvases carried over when a batch doesn't end on a sheet boundary

  const referralBatches = chunk(sorted, RENDER_BATCH_SIZE);

  for (const referralBatch of referralBatches) {
    // Render only this batch's canvases — everything from prior batches
    // is already gone (turned into PDF bytes) by the time we get here.
    const batchCanvases = await Promise.all(
      referralBatch.map(renderReferralFormCanvas),
    );

    const available = [...leftover, ...batchCanvases];
    const sheets = chunk(available, FORMS_PER_SHEET);

    // Hold back a final partial group in case the *next* batch completes it,
    // so we don't ship a sheet with only 1–3 forms unless it's truly the end.
    const isLastBatch =
      referralBatch === referralBatches[referralBatches.length - 1];
    const completeSheets = isLastBatch
      ? sheets
      : sheets.filter((s) => s.length === FORMS_PER_SHEET);
    leftover = isLastBatch
      ? []
      : (sheets.find((s) => s.length < FORMS_PER_SHEET) ?? []);

    completeSheets.forEach((sheetCanvases) => {
      const pdf = buildSheetPdf(sheetCanvases);
      const pdfBytes = pdf.output("arraybuffer");
      sheetIndex += 1;
      const sheetNumber = String(sheetIndex).padStart(3, "0");
      zip.file(`referral-forms-sheet-${sheetNumber}.pdf`, pdfBytes);
    });

    onProgress?.({
      formsProcessed: Math.min(
        (referralBatches.indexOf(referralBatch) + 1) * RENDER_BATCH_SIZE,
        sorted.length,
      ),
      totalForms: sorted.length,
    });
    // batchCanvases (and any consumed leftover canvases) fall out of scope
    // here and become eligible for GC before the next loop iteration.
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = zipFileName ?? defaultZipFileName();
  anchor.click();
  URL.revokeObjectURL(url);

  return sheetIndex;
}

function buildSheetPdf(sheetCanvases) {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  drawCutGuides(pdf);

  const usableWidth = A4_WIDTH_MM - PAGE_MARGIN_MM * 2 - CUT_GUTTER_MM;
  const usableHeight = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2 - CUT_GUTTER_MM;
  const cellWidth = usableWidth / 2;
  const cellHeight = usableHeight / 2;

  sheetCanvases.forEach((canvas, positionOnSheet) => {
    const col = positionOnSheet % 2;
    const row = Math.floor(positionOnSheet / 2);
    const cellX = PAGE_MARGIN_MM + col * (cellWidth + CUT_GUTTER_MM);
    const cellY = PAGE_MARGIN_MM + row * (cellHeight + CUT_GUTTER_MM);

    let drawWidth = cellWidth;
    let drawHeight = drawWidth / FORM_ASPECT;
    if (drawHeight > cellHeight) {
      drawHeight = cellHeight;
      drawWidth = drawHeight * FORM_ASPECT;
    }
    const drawX = cellX + (cellWidth - drawWidth) / 2;
    const drawY = cellY + (cellHeight - drawHeight) / 2;

    const imageData = canvas.toDataURL("image/jpeg", 0.9);
    pdf.addImage(imageData, "JPEG", drawX, drawY, drawWidth, drawHeight);
  });

  return pdf;
}

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

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function defaultZipFileName() {
  const today = new Date().toISOString().slice(0, 10);
  return `referral-forms-${today}.zip`;
}

// --- Existing helpers, unchanged ---
function inkFontFor(value, maxWidth) {
  const fontSizes = [48, 46, 44, 42, 40, 38, 36, 34, 32];
  for (const size of fontSizes) {
    const font = `bold ${size}px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;
    const measureContext = document.createElement("canvas").getContext("2d");
    measureContext.font = font;
    if (measureContext.measureText(value).width <= maxWidth) return font;
  }
  return 'bold 30px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
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

function loadImage(source) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

async function drawSignature(context, source, x, y, width, height) {
  if (!source) return;
  const image = await loadImage(source);
  if (!image) return;

  const crop = opaqueBounds(image);
  if (!crop) return;
  const scale = Math.min(width / crop.width, height / crop.height);
  const drawWidth = crop.width * scale;
  const drawHeight = crop.height * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  const signatureCanvas = document.createElement("canvas");
  signatureCanvas.width = crop.width;
  signatureCanvas.height = crop.height;
  const signatureContext = signatureCanvas.getContext("2d");
  signatureContext.drawImage(
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
  signatureContext.globalCompositeOperation = "source-in";
  signatureContext.fillStyle = "#253d98";
  signatureContext.fillRect(0, 0, crop.width, crop.height);

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
}

function seededJitter(source) {
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

function opaqueBounds(image) {
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
