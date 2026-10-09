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

/* -------------------------------------------- staging area for direct uploads */

/**
 * Why this exists: a Vercel function's request-body ceiling (4.5 MB) sits *below* this
 * app's own per-file limit, so a large photo can never be carried by an API call — the
 * platform refuses it before any of our code runs. A photo too big for a form request
 * is therefore PUT straight into storage with a single-path grant, and only the *key*
 * comes back here for verification.
 *
 * The grant only ever points at `images/incoming/<month>/<uuid>`:
 *  - the key is minted here, so a client can never choose a path, overwrite a real
 *    asset or walk out of the bucket;
 *  - that shape deliberately fails the /api/media route's own pattern, so an object
 *    that has not been verified and registered is not merely private, it is
 *    unreachable — no half-uploaded or bogus file can ever be shown to anyone;
 *  - verification is the *same* `acceptUpload` a form upload goes through, run over the
 *    bytes that actually arrived, so nothing about validation is weaker on this path.
 */
export const STAGING_PREFIX = "images/incoming";
const STAGING_KEY = /^images\/incoming\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const stagingKey = () => `${STAGING_PREFIX}/${month()}/${crypto.randomUUID()}`;

/** True only for a key this file generated. Cleanup is refused for anything else. */
export const isStagingKey = (value) => STAGING_KEY.test(String(value ?? ""));

/** The months a sweep may look inside: this one and the one before. */
const stagingMonths = () => {
  const now = Date.now();
  const label = (offset) => new Date(now + offset).toISOString().slice(0, 7);
  return [...new Set([label(0), label(-32 * 24 * 60 * 60 * 1000)])].filter((value) => /^\d{4}-\d{2}$/.test(value));
};

const TYPE_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

/** Can this deployment hand out storage grants at all? */
export const directUploadReady = (store) => Boolean(config.directUploads && store?.driver?.media?.sign);

/**
 * Asks storage for a short-lived grant for one brand-new staging key.
 * `size` is only an early, friendly refusal — never the decision, because the real
 * limit is applied to the bytes at commit time.
 * @returns {{supported:true, staging_key:string, method:string, upload_url:string, headers:object}|{supported:false, reason:string}}
 */
export async function beginStagedUpload({ name = "", size = 0 } = {}) {
  const declared = Number(size) || 0;
  if (declared > config.maxImageBytes) {
    throw tooLarge(
      `ছবিটি অনেক বড় (${(declared / 1024 / 1024).toFixed(1)} MB)। সর্বোচ্চ ${(config.maxImageBytes / 1024 / 1024).toFixed(0)} MB গ্রহণ করা হয় — আগে ছোট (২০০০ পিক্সেলের নিচে) করে নিন।`,
    );
  }
  if (!config.directUploads) return { supported: false, reason: "সার্ভারে সরাসরি আপলোড বন্ধ রাখা হয়েছে।" };
  const store = await getStore();
  if (!store?.driver?.media?.sign) return { supported: false, reason: "এই সংরক্ষণ ব্যবস্থা সরাসরি আপলোড সমর্থন করে না।" };
  const key = stagingKey();
  const ext = String(name).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  try {
    const grant = await store.driver.media.sign(key, { contentType: TYPE_BY_EXT[ext] || "image/jpeg" });
    if (!grant?.upload_url) return { supported: false, reason: "স্টোরেজ থেকে আপলোডের ঠিকানা পাওয়া যায়নি।" };
    return { supported: true, staging_key: key, method: grant.method || "PUT", upload_url: grant.upload_url, headers: grant.headers ?? {} };
  } catch (error) {
    // Storage refusing to sign is not the teacher's upload failing: report it and let
    // the caller fall back to the form path, which still carries everything inside the
    // platform's request ceiling.
    console.error("[cms] sign failed", error?.message || error);
    return { supported: false, reason: error instanceof HttpError ? error.message : "স্টোরেজ থেকে আপলোডের অনুমতি পাওয়া যায়নি।" };
  }
}

/**
 * The bytes the browser put into staging, held to exactly the rules a form upload
 * gets. Staging is emptied afterwards whatever the outcome, so a rejected or
 * half-finished upload cannot pile up in the bucket.
 */
export async function commitStagedUpload(key, { name = "" } = {}) {
  if (!isStagingKey(key)) throw badRequest("আপলোডের ঠিকানা সঠিক নয়।");
  const store = await getStore();
  try {
    // Refuse on the recorded size first when storage reports one: a 40 MB mistake
    // should be answered with a message, not by pulling 40 MB into memory.
    const info = await store.driver.media.stat?.(key).catch(() => null);
    if (info?.bytes !== undefined && info.bytes > config.maxImageBytes) {
      throw tooLarge(`ছবিটি অনেক বড় (${(info.bytes / 1024 / 1024).toFixed(1)} MB)। সর্বোচ্চ ${(config.maxImageBytes / 1024 / 1024).toFixed(0)} MB গ্রহণ করা হয়।`);
    }
    const found = await store.driver.media.read(key, null);
    if (!found?.buffer?.length) {
      throw new HttpError(404, "staging_missing", "স্টোরেজে ছবিটি পাওয়া যায়নি — আপলোডটি সম্ভবত শেষ হয়নি। আবার চাপুন।");
    }
    if (found.buffer.length > config.maxImageBytes) {
      throw tooLarge(`ছবিটি অনেক বড় (${(found.buffer.length / 1024 / 1024).toFixed(1)} MB)। সর্বোচ্চ ${(config.maxImageBytes / 1024 / 1024).toFixed(0)} MB গ্রহণ করা হয়।`);
    }
    return await acceptUpload({ filename: name || "upload", buffer: found.buffer, type: "application/octet-stream" });
  } finally {
    await discardStagedUpload(key);
  }
}

/** Deletes one staging object. Returns false for any other key, by design. */
export async function discardStagedUpload(key) {
  if (!isStagingKey(key)) return false;
  const store = await getStore();
  await store.driver.media.remove(key).catch(() => null);
  return true;
}

const entryAgeMs = (entry) => {
  if (Number.isFinite(entry?.mtimeMs)) return Date.now() - entry.mtimeMs;
  const stamp = entry?.updated_at || entry?.created_at || entry?.last_accessed_at;
  const parsed = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(parsed) ? Date.now() - parsed : null;
};

/**
 * Clears staging objects a closed tab left behind. Best effort, and doubly bounded: it
 * only ever lists inside the staging prefix, and it only ever deletes a key that passes
 * isStagingKey() — a published asset cannot be named by this path at all.
 */
export async function sweepStagedUploads(store, { olderThanMs = config.stagingMaxAgeHours * 60 * 60 * 1000 } = {}) {
  const list = store?.driver?.media?.list;
  if (!list) return 0;
  let removed = 0;
  for (const label of stagingMonths()) {
    let entries = [];
    try {
      entries = (await list(`${STAGING_PREFIX}/${label}/`, 200)) ?? [];
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A listing may answer with a full key or with a bare name — accept either, and
      // let the pattern check below reject anything unexpected.
      const raw =
        typeof entry === "string"
          ? entry
          : entry?.path ?? (entry?.name ? (String(entry.name).includes("/") ? entry.name : `${STAGING_PREFIX}/${label}/${entry.name}`) : "");
      if (!isStagingKey(raw)) continue;
      const age = entryAgeMs(entry);
      if (age === null || age < olderThanMs) continue;
      await store.driver.media.remove(raw).catch(() => null);
      removed += 1;
    }
  }
  return removed;
}

/** The only URL shape a browser is ever given for a stored object. */
/**
 * The only media URL shape the browser is ever given: the media function's own path
 * plus the object key as a query parameter. A storage key is `images/2026-10/<uuid>.jpg`
 * — three segments — and Vercel maps a function file to its own path and the one
 * segment under it, so a key carried in the path would land past the mapped route and
 * 404 before any code ran. api/media.mjs is therefore reached as /api/media?path=…
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
