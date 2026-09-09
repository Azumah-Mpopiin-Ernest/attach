import hospitalLogo from "../hfch-logo.png";

const FORM_WIDTH = 1600;
const FORM_HEIGHT = 1067;
export async function downloadReferralForm(referral) {
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

  // Measure the title text first so the crest can sit flush against it,
  // matching the physical form where the logo touches the first letter.
  const titleFont = "bold 43px Arial, sans-serif";
  context.font = titleFont;
  const titleWidth = context.measureText("HOLY FAMILY HOSPITAL, BEREKUM").width;
  const titleCenterX = 850;
  const titleLeftEdge = titleCenterX - titleWidth / 2;

  const logoSize = 100;
  const logoGap = 16;
  const logoX = titleLeftEdge - logoSize - logoGap;
  const logoY = 96; // vertically centered against the two title lines below
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
    310,
    585,
    300,
    85,
  );
  await drawSignature(
    context,
    referral.referredToSignatureUrl,
    1060,
    585,
    300,
    85,
  );

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

function inkFontFor(value, maxWidth) {
  const fontSizes = [48, 46, 44, 42, 40, 38, 36, 34, 32];
  for (const size of fontSizes) {
    const font = `bold ${size}px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;
    // The caller owns the canvas context; measure through a temporary canvas
    // so long LHIMS numbers shrink before reaching the form border.
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

  // Keep the signature crisp instead of soft when a small source image gets
  // scaled up to fill the larger box.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  // A perfectly centered, perfectly level signature reads as a stamped
  // image rather than a real pen stroke. Derive a small, fixed tilt/offset
  // from the source URL so each doctor's signature leans a consistent but
  // slightly different way every time this same signature is rendered
  // (deterministic, not random, so re-downloads of the same referral match).
  const { angleDeg, offsetX, offsetY } = seededJitter(source);
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  context.save();
  context.translate(centerX, centerY);
  context.rotate((angleDeg * Math.PI) / 180);
  context.translate(-centerX + offsetX, -centerY + offsetY);

  // Layer a couple of near-solid, tightly-offset copies so the stroke reads
  // as bold, pressure-heavy ink rather than a faint smear.
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

// Deterministic pseudo-randomness keyed off the signature's own URL, so the
// same signature always tilts the same way instead of jittering on every
// download.
function seededJitter(source) {
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const a = (Math.abs(hash) % 1000) / 1000;
  const b = (Math.abs(hash >> 8) % 1000) / 1000;
  const c = (Math.abs(hash >> 16) % 1000) / 1000;
  return {
    angleDeg: (a - 0.5) * 5, // -2.5..2.5 degrees
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
  let left = canvas.width;
  let top = canvas.height;
  let right = 0;
  let bottom = 0;
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

  // Pad by a couple of pixels (clamped to the source image) so soft,
  // anti-aliased stroke edges aren't cut off at the crop boundary.
  const pad = 2;
  const paddedLeft = Math.max(0, left - pad);
  const paddedTop = Math.max(0, top - pad);
  const paddedRight = Math.min(canvas.width - 1, right + pad);
  const paddedBottom = Math.min(canvas.height - 1, bottom + pad);

  return {
    x: paddedLeft,
    y: paddedTop,
    width: paddedRight - paddedLeft + 1,
    height: paddedBottom - paddedTop + 1,
  };
}
