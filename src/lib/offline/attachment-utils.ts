const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const);

export type AllowedAttachmentMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per spec Section 17
const MAX_IMAGE_DIMENSION = 1600;
const IMAGE_QUALITY = 0.78;

export function isAllowedAttachmentMime(mime: string): mime is AllowedAttachmentMime {
  return ALLOWED_MIME_TYPES.has(mime as AllowedAttachmentMime);
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", copy);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  throw new Error("A secure HTTPS connection with SHA-256 support is required.");
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(",") ? (dataUrl.split(",")[1] ?? "") : dataUrl;
  const binary = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export interface PreparedAttachmentFile {
  fileName: string;
  mimeType: AllowedAttachmentMime;
  sizeBytes: number;
  sha256Checksum: string;
  dataUrl: string;
  exifStripped: boolean;
}

/**
 * Validates file type & size, re-encodes images through Canvas to compress and strip EXIF metadata,
 * and computes a SHA-256 checksum for integrity verification.
 */
export async function prepareAttachmentFile(file: File): Promise<PreparedAttachmentFile> {
  if (!isAllowedAttachmentMime(file.type)) {
    throw new Error("Only JPEG, PNG, WebP images and PDF files are allowed.");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("File is too large. Maximum size is 10 MB.");
  }

  if (file.type === "application/pdf") {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const checksum = await computeSha256Hex(buffer);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read PDF file."));
      reader.readAsDataURL(file);
    });
    return {
      fileName: file.name,
      mimeType: "application/pdf",
      sizeBytes: buffer.byteLength,
      sha256Checksum: checksum,
      dataUrl,
      exifStripped: false,
    };
  }

  // Re-encode image through HTMLCanvasElement to compress and strip EXIF metadata
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });

  if (typeof document === "undefined") {
    const bytes = dataUrlToBytes(rawDataUrl);
    return {
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: bytes.byteLength,
      sha256Checksum: await computeSha256Hex(bytes),
      dataUrl: rawDataUrl,
      exifStripped: false,
    };
  }

  const compressedDataUrl = await new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width || 1, img.height || 1));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Photo compression unavailable. No photo was saved."));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
    };
    img.onerror = () => reject(new Error("This file could not be decoded as a photograph."));
    img.src = rawDataUrl;
  });

  const bytes = dataUrlToBytes(compressedDataUrl);
  return {
    fileName: file.name.replace(/\.(png|webp)$/i, ".jpg"),
    mimeType: "image/jpeg",
    sizeBytes: bytes.byteLength,
    sha256Checksum: await computeSha256Hex(bytes),
    dataUrl: compressedDataUrl,
    exifStripped: true,
  };
}