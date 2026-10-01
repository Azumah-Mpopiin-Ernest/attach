import {
  renderReferralFormJpegBlob,
  referralFormFileName,
} from "../referralForm";

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

const sha256Hex = async (blob) => {
  if (!globalThis.crypto?.subtle) return null; // insecure origin: the extension still checks the length
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Throws if the form cannot be produced (e.g. a signature is not cached).
export async function buildJob(referral) {
  const blob = await renderReferralFormJpegBlob(referral);
  return {
    referralId: referral.id,
    patientId: String(referral.patientId ?? ""),
    expectedFileName: referralFormFileName(referral),
    mimeType: "image/jpeg",
    size: blob.size,
    bytesB64: await blobToBase64(blob),
    sha256: await sha256Hex(blob),
  };
}
