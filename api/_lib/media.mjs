/* Upload handling: validation, format sniffing, storage keys, and the URL scheme.
 *
 * Rules that matter here:
 *  - a file's type comes from its bytes, never from the name or the MIME the
 *    browser sent (a renamed .php/.svg/.html must not be trusted);
 *  - object keys are generated here (UUID + month prefix), so a user can never
 *    choose a path, overwrite someone else's file, or walk out of the bucket;
 *  - everything is size-capped before a single byte is written;
 *  - the browser is only ever given a site-relative /api/media URL, so no
 *    storage credential, bucket name or project URL leaks into client code.
 */

import crypto from "node:crypto";

import { config } from "./config.mjs";
import { HttpError, badRequest, tooLarge } from "./http.mjs";
import { getStore } from "./db.mjs";

const IMAGE_KINDS = {
  "image/jpeg": { ext: "jpg", label: "JPEG ছবি" },
  "image/png": { ext: "png", label: "PNG ছবি" },
  "image/webp": { ext: "webp", label: "WebP ছবি" },
  "image/gif": { ext: "gif", label: "GIF ছবি" },
};

const DOCUMENT_KINDS = {
  "application/pdf": { ext: "pdf", label: "PDF নথি" },
};

const be16 = (buffer, offset) => buffer.readUInt16BE(offset);
const be32 = (buffer, offset) => buffer.readUInt32BE(offset);
const le16 = (buffer, offset) => buffer.readUInt16LE(offset);

/** Returns `{ mime, width, height }` for a real image, or null when it is not one. */
export const sniffImage = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;

  // PNG: 89 50 4E 47 .. then IHDR at offset 16
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
    return { mime: "image/png", width: be32(buffer, 16), height: be32(buffer, 20) };
  }

  // JPEG: SOFn markers carry the frame dimensions
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return { mime: "image/jpeg", height: be16(buffer, offset + 5), width: be16(buffer, offset + 7) };
      }
      if ([0xd8, 0x01, ...Array.from({ length: 14 }, (_, i) => 0xd0 + i)].includes(marker)) {
        offset += 2;
        continue;
      }
      offset += 2 + be16(buffer, offset + 2);
    }
    return { mime: "image/jpeg", width: 0, height: 0 };
  }

  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const tag = buffer.toString("ascii", 12, 16);
    if (tag === "VP8 " && buffer.length > 30) {
      return { mime: "image/webp", width: le16(buffer, 26) & 0x3fff, height: le16(buffer, 28) & 0x3fff };
    }
    if (tag === "VP8L" && buffer.length > 25) {
      const bits = buffer.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (tag === "VP8X" && buffer.length > 30) {
      return {
        mime: "image/webp",
        width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
      };
    }
    return { mime: "image/webp", width: 0, height: 0 };
  }

  // GIF
  if (buffer.toString("ascii", 0, 6).startsWith("GIF8")) {
    return { mime: "image/gif", width: le16(buffer, 6), height: le16(buffer, 8) };
  }
  return null;
};

export const sniffDocument = (buffer) => {
  if (Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.toString("ascii", 0, 5) === "%PDF-") {
    return { mime: "application/pdf", width: 0, height: 0 };
  }
  return null;
};

const month = () => new Date().toISOString().slice(0, 7);

const objectKey = (kind, ext) =>
  `${kind === "image" ? config.imagePrefix : config.documentPrefix}/${month()}/${crypto.randomUUID()}.${ext}`;

/**
 * Validates one uploaded part and, when `persist` is true, stores it.
 * @returns {{path:string,name:string,mime:string,bytes:number,width:number,height:number}}
 */
export async function acceptUpload(part, { persist = true } = {}) {
  const filename = String(part.filename || "").replace(/[^\w.\-+\u0980-\u09ff ]/g, "").trim().slice(0, 120);
  const buffer = part.buffer;
  if (!filename) throw badRequest("ফাইলের নাম দেওয়া যায়নি।");

  const image = sniffImage(buffer);
  const document = image ? null : sniffDocument(buffer);
  const kind = image ? IMAGE_KINDS[image.mime] : document ? DOCUMENT_KINDS[document.mime] : null;
  if (!kind) {
    throw new HttpError(415, "bad_file_type", "শুধুমাত্র JPEG, PNG, WebP ছবি অথবা PDF নথি গ্রহণ করা হয়।");
  }

  const limit = image ? config.maxImageBytes : config.maxDocumentBytes;
  if (buffer.length > limit) {
    throw tooLarge(
      `${kind.label} অনেক বড় (${(buffer.length / 1024 / 1024).toFixed(1)} MB)। সর্বোচ্চ ${(limit / 1024 / 1024).toFixed(0)} MB আপলোড করা যাবে। ` +
        `ফোন থেকে ছবি তুললে ছোট করে (২০০০ পিক্সেলের নিচে) আপলোড করুন।`,
    );
  }
  if (buffer.length < 128) throw badRequest("ফাইলটি ক্ষতিগ্রস্ত বলে মনে হচ্ছে।");

  const key = objectKey(image ? "image" : "document", kind.ext);
  const record = {
    path: key,
    name: filename,
    mime: image ? image.mime : "application/pdf",
    bytes: buffer.length,
    width: image?.width || null,
    height: image?.height || null,
  };
  if (!persist) return record;

  const store = await getStore();
  await store.driver.media.put(key, buffer, record.mime);
  return record;
}

/** Object existence is checked before a path is accepted from a client. */
export async function assertMediaExists(pathValue) {
  if (!pathValue) return;
  const store = await getStore();
  const exists = await store.driver.media.exists(pathValue).catch(() => false);
  if (!exists) throw badRequest("সংযুক্ত ফাইলটি খুঁজে পাওয়া যায়নি — আবার আপলোড করুন।", { file: "ফাইলটি হারিয়ে গেছে।" });
}

export async function deleteMedia(pathValue) {
  if (!pathValue) return;
  const store = await getStore();
  await store.driver.media.remove(pathValue).catch(() => null);
}

/** The only URL shape a browser is ever given for a stored object. */
/**
 * The only media URL shape the browser is ever given: one path segment plus the
 * object key as a query parameter. A storage key is `images/2026-10/<uuid>.jpg` —
 * three segments — and Vercel's function routing only maps /api/media/<one segment>
 * to the handler, so embedding the key in the path would 404 on a real deployment.
 */
export const mediaUrl = (pathValue, transform = null) => {
  if (!pathValue) return null;
  const params = new URLSearchParams({ path: pathValue });
  if (transform) {
    params.set("w", String(transform.width));
    params.set("h", String(transform.height));
    params.set("q", String(transform.quality));
  }
  return `/api/media?${params.toString()}`;
};

export const thumbTransform = () =>
  config.imageTransform ? { width: config.thumbWidth, height: config.thumbHeight, quality: config.thumbQuality } : null;

/** Strips storage internals down to what a page or the admin list needs. */
export const fileMeta = (row, { transform = null } = {}) =>
  row.file_path
    ? {
        name: row.file_name || "সংযুক্ত নথি",
        mime: row.file_mime || null,
        bytes: row.file_bytes || null,
        url: mediaUrl(row.file_path, transform),
      }
    : null;

export { IMAGE_KINDS, DOCUMENT_KINDS };

export { moduleOnly as default } from "./guard.mjs";
