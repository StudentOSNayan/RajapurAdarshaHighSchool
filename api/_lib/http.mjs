/* Minimal HTTP plumbing for Node-style serverless handlers (Vercel) and for the
 * local dev server, which calls the very same handlers. No frameworks, no deps:
 * the production build of this project must stay a plain static deploy.
 */

import { config, isSecureRequest } from "./config.mjs";

/* ---------------------------------------------------------------- responses */

const HOP_BY_HOP = new Set(["content-length", "transfer-encoding", "content-encoding"]);

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = body === undefined || body === null ? "" : Buffer.from(body);
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
    ...(payload.length ? { "Content-Length": String(payload.length) } : {}),
  });
  res.end(payload.length ? payload : undefined);
}

export function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    ...headers,
  });
}

export const ok = (res, data, headers) => json(res, 200, data ?? { ok: true }, headers);

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra ?? null;
  }
}

export const badRequest = (message, extra) => new HttpError(400, "bad_request", message, extra);
export const unauthorized = (message = "প্রবেশাধিকার প্রয়োজন।") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "এই কাজটি করার অনুমতি নেই।") => new HttpError(403, "forbidden", message);
export const notFound = (message = "খুঁজে পাওয়া যায়নি।") => new HttpError(404, "not_found", message);
export const conflict = (message) => new HttpError(409, "conflict", message);
export const tooLarge = (message) => new HttpError(413, "too_large", message);
export const tooMany = (message) => new HttpError(429, "too_many_requests", message);

/** Turns any thrown value into a JSON error response that never leaks internals. */
export function fail(res, error, request) {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  if (!known) {
    // Only the server log sees the real error; the browser gets a generic message.
    console.error("[cms] unhandled error", request?.method, request?.url, error);
  }
  return json(res, status, {
    error: known ? error.code : "server_error",
    message: known ? error.message : "সার্ভারে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।",
    ...(known && error.extra ? { fields: error.extra } : {}),
  });
}

/* ------------------------------------------------------------------ requests */

export function readBody(req, maxBytes = config.maxFormBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(tooLarge(`অনুরোধটি অনেক বড় (সর্বোচ্চ ${Math.floor(maxBytes / 1024 / 1024)} MB)।`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const type = String(req.headers["content-type"] || "");
  if (!type.includes("application/json")) {
    throw badRequest("Content-Type application/json হতে হবে।");
  }
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw badRequest("JSON body একটি object হতে হবে।");
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest("JSON সঠিকভাবে পড়া যায়নি।");
  }
}

/* --------------------------------------------------------- cookies and CSRF */

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[name] = part.slice(index + 1).trim();
    }
  }
  return out;
}

/**
 * Session cookie: HttpOnly (JavaScript cannot read it, so an XSS bug cannot
 * steal it), SameSite=Lax (cross-site form POSTs never carry it), Secure on HTTPS.
 * No Domain attribute -> it stays pinned to exactly this host.
 */
export function sessionCookie(value, req, maxAgeSeconds) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req.headers)) parts.push("Secure");
  return parts.join("; ");
}

/** CSRF companion cookie: readable by the admin script on purpose (double-submit). */
export function csrfCookie(value, req) {
  const parts = [`rahs_csrf=${value}`, "Path=/", "SameSite=Lax", "Max-Age=86400"];
  if (isSecureRequest(req.headers)) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookies(req) {
  const secure = isSecureRequest(req.headers) ? "; Secure" : "";
  return [
    `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `rahs_csrf=; Path=/; SameSite=Lax; Max-Age=0${secure}`,
  ];
}

/** Real browser requests always have a Host header; use it as the CSRF origin. */
export const requestOrigin = (req) => {
  const host = req.headers.host || "";
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  return host ? `${proto}://${host}` : "";
};

export const isMutating = (method) => !["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());

/**
 * Defences applied to every state-changing call:
 *  1. SameSite=Lax cookie => a cross-site <form> post never sends it.
 *  2. Origin (when present) must match our own host.
 *  3. A double-submit token must be echoed in the X-CSRF-Token header.
 */
export function assertSameOrigin(req, cookies) {
  const origin = req.headers.origin;
  if (origin && origin !== requestOrigin(req)) {
    throw forbidden("Cross-site request ব্লক করা হয়েছে।");
  }
  if (req.headers["sec-fetch-site"] && String(req.headers["sec-fetch-site"]) === "cross-site") {
    throw forbidden("Cross-site request ব্লক করা হয়েছে।");
  }
  const supplied = req.headers[config.csrfHeaderName];
  if (!supplied || !cookies.rahs_csrf || supplied !== cookies.rahs_csrf) {
    throw forbidden("CSRF টোকেন মেলেনি — পেজটি রিলোড করে আবার চেষ্টা করুন।");
  }
}

/* ------------------------------------------------------------------- helpers */

export const clientIp = (req) => {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.socket?.remoteAddress || "unknown").slice(0, 100);
};

export const publicCacheHeaders = () => ({
  "Cache-Control": `public, s-maxage=${config.publicCacheSeconds}, stale-while-revalidate=${config.publicCacheStaleSeconds}`,
  "Vary": "Accept-Encoding",
});

export const noStore = () => ({ "Cache-Control": "no-store, max-age=0" });

export { HOP_BY_HOP };

/* Not a route — see _lib/guard.mjs. */
export { moduleOnly as default } from "./guard.mjs";
