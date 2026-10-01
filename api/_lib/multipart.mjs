/* A tiny multipart/form-data reader (no dependency, no bundler step).
 *
 * Only what the admin app needs: text fields plus file parts. Everything is read
 * into memory under an explicit byte cap, so an oversized upload is refused with a
 * clear 413 before it can exhaust the function's memory.
 */

import { badRequest, HttpError } from "./http.mjs";
import { readBody } from "./http.mjs";

const CR = 0x0d;
const LF = 0x0a;

const findBuffer = (haystack, needle, fromIndex = 0) => haystack.indexOf(needle, fromIndex);

const headersFrom = (block) => {
  const out = {};
  for (const line of block.split("\r\n")) {
    const index = line.indexOf(":");
    if (index < 1) continue;
    out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return out;
};

const disposition = (value = "") => {
  const name = /name="([^"]*)"/.exec(value)?.[1] ?? "";
  const filename = /filename="([^"]*)"/.exec(value)?.[1];
  return { name, filename: filename === undefined ? null : filename };
};

export async function parseMultipart(req, maxBytes = 50 * 1024 * 1024) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw badRequest("ফর্মটি multipart/form-data হতে হবে।");
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw badRequest("ফর্মের সীমানা (boundary) পাওয়া যায়নি।");
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`, "binary");

  let buffer;
  try {
    buffer = await readBody(req, maxBytes);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) {
      throw badRequest(`আপলোড অনেক বড় (সর্বোচ্চ ${Math.round(maxBytes / 1024 / 1024)} MB)।`);
    }
    throw error;
  }
  if (!buffer.length) throw badRequest("খালি ফর্ম।");

  const fields = {};
  const files = [];
  let cursor = findBuffer(buffer, boundary, 0);
  if (cursor < 0) throw badRequest("ফর্মটি পড়া যায়নি।");

  while (cursor >= 0) {
    let start = cursor + boundary.length;
    if (buffer[start] === CR && buffer[start + 1] === LF) start += 2;
    else break; // closing "--"
    const next = findBuffer(buffer, boundary, start);
    if (next < 0) break;
    let end = next;
    if (buffer[end - 2] === CR && buffer[end - 1] === LF) end -= 2;
    const segment = buffer.subarray(start, end);
    const headerEnd = findBuffer(segment, Buffer.from("\r\n\r\n", "binary"), 0);
    if (headerEnd >= 0) {
      const headers = headersFrom(segment.subarray(0, headerEnd).toString("utf8"));
      const body = segment.subarray(headerEnd + 4);
      const { name, filename } = disposition(headers["content-disposition"]);
      if (name) {
        if (filename === null) {
          fields[name] = body.toString("utf8");
        } else if (filename !== "" || body.length) {
          files.push({ field: name, filename: filename ?? "upload", buffer: body, type: headers["content-type"] || "application/octet-stream" });
        }
      }
    }
    cursor = next;
  }

  if (!Object.keys(fields).length && !files.length) throw badRequest("ফর্মে কোনো তথ্য পাওয়া যায়নি।");
  return { fields, files };
}

export { moduleOnly as default } from "./guard.mjs";
