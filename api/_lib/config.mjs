/* Runtime configuration for the content API.
 *
 * Every value here is read from server-side environment variables only.
 * Nothing in this file (or anywhere under /api) is ever shipped to the browser:
 * the admin app and the public pages talk to the JSON endpoints below and never
 * see a database URL, a service-role key or a storage credential.
 */

const env = process.env;

/** "1" | "true" | "yes" (case-insensitive) */
const flag = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * A value pasted into the Vercel dashboard often arrives still wearing its
 * packaging: surrounding quotes, a trailing newline, a "Bearer " prefix, or
 * percent-escaping copied out of a URL field. Neither a key nor a project URL can
 * legitimately contain whitespace, so it is removed here — before any validation —
 * so a correct credential is never rejected because of how it was copied.
 */
const normalizeKey = (value) =>
  String(value ?? "")
    .replace(/%3D/g, "=")
    .replace(/%0[AD]/gi, "")
    .replace(/\s+/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/[,;]+$/, "");

const normalizeUrl = (value) =>
  String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\/+rest\/v1\/?$/, "")
    .replace(/\/+$/, "");

/** Read the `role` claim out of a Supabase JWT without verifying it (config sanity only). */
const keyRole = (key) => {
  const payload = String(key).split(".")[1];
  if (!payload) return "";
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims.role === "string" ? claims.role : "";
  } catch {
    return "";
  }
};

/**
 * Classifies the configured Supabase credential so a mistake can be *described*
 * instead of reported as an opaque "unknown". The value itself is never returned,
 * echoed or logged — only its length and which shape it has.
 *
 * Two formats are valid server-side credentials:
 *   - the legacy JWT, whose payload carries `role: "service_role"`;
 *   - the current `sb_secret_…` key, which is opaque (no JWT, no claims) and is the
 *     secret half of Supabase's publishable/secret pair.
 * Anything recognisable as a *public* credential (`sb_publishable_…`, `sb_anon_…`, or
 * a JWT whose role is not `service_role`) is refused. That is the point of the check:
 * a key that can be pasted into a browser must never be used as a server credential.
 */
export const describeSupabaseKey = (raw) => {
  const key = normalizeKey(raw);
  if (!key) return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY is not set." };

  const role = keyRole(key);
  if (role) {
    return role === "service_role"
      ? { ok: true, kind: "legacy JWT" }
      : {
          ok: false,
          reason:
            `SUPABASE_SERVICE_ROLE_KEY is a JWT with role "${role}" — that is the public (anon) key. ` +
            "Use the service_role secret key instead.",
        };
  }

  if (/^sb_secret_/i.test(key)) return { ok: true, kind: "sb_secret key" };
  if (/^sb_(publishable|anon|public)/i.test(key)) {
    return {
      ok: false,
      reason: "SUPABASE_SERVICE_ROLE_KEY starts with sb_publishable_ — that is the public key, not the secret one.",
    };
  }

  // Deliberately reports only the length and which known prefix was present — never
  // any part of the secret itself.
  const looksLikeJwt = key.startsWith("eyJ");
  return {
    ok: false,
    reason:
      `SUPABASE_SERVICE_ROLE_KEY was received (${key.length} characters${looksLikeJwt ? ", starting with the JWT header \"eyJ\"" : ""}) ` +
      "but it is neither a decodable service_role JWT nor an sb_secret_ key. A JWT payload that cannot be read almost " +
      "always means the value was truncated or line-wrapped while copying — paste the raw key again from " +
      "Project Settings → API → secret key.",
  };
};

export const config = {
  /**
   * "supabase" -> Postgres (via PostgREST) + Storage buckets. Production.
   * "local"    -> JSON file on disk. Local development / offline demo only.
   */
  driver: env.CMS_DRIVER === "local" ? "local" : "supabase",

  /** Set to "1" to allow the local driver outside development (used by the dev server). */
  allowLocalDriver: flag(env.CMS_ALLOW_LOCAL_DRIVER, false),

  supabaseUrl: normalizeUrl(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || ""),
  supabaseServiceRoleKey: normalizeKey(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || ""),

  /** Storage bucket that holds uploaded gallery images and notice/routine documents. */
  storageBucket: env.CMS_STORAGE_BUCKET || "media",
  imagePrefix: "images",
  documentPrefix: "docs",

  /**
   * Supabase image transformations for gallery thumbnails
   * (renders a resized, re-compressed WebP copy at the CDN edge).
   * The lightbox always uses the untouched original file.
   */
  imageTransform: flag(env.CMS_IMAGE_TRANSFORM, true),
  thumbWidth: int(env.CMS_THUMB_WIDTH, 800),
  thumbHeight: int(env.CMS_THUMB_HEIGHT, 600),
  thumbQuality: int(env.CMS_THUMB_QUALITY, 72),

  /** Upload limits (enforced server-side, before a byte is stored). */
  maxImageBytes: int(env.CMS_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
  maxDocumentBytes: int(env.CMS_MAX_DOCUMENT_BYTES, 5 * 1024 * 1024),
  /* A Vercel Hobby function has a 10s wall clock, so one request is capped well
   * below "as much as the browser will send": batch uploads and the message below
   * tell the teacher to send the rest in a second go. */
  maxImagesPerUpload: int(env.CMS_MAX_IMAGES_PER_UPLOAD, 6),
  maxFormBytes: int(env.CMS_MAX_FORM_BYTES, 24 * 1024 * 1024),

  /** Session lifetime. Sliding: each authenticated request extends it. */
  sessionHours: int(env.CMS_SESSION_HOURS, 12),

  /** Login throttling: CMS_LOGIN_MAX_FAILS failures per CMS_LOGIN_WINDOW_MINUTES. */
  loginMaxFails: int(env.CMS_LOGIN_MAX_FAILS, 8),
  loginWindowMinutes: int(env.CMS_LOGIN_WINDOW_MINUTES, 15),

  /** Public feed caching (edge/CDN). Content is low-churn, so short TTL is plenty. */
  publicCacheSeconds: int(env.CMS_PUBLIC_CACHE_SECONDS, 60),
  publicCacheStaleSeconds: int(env.CMS_PUBLIC_CACHE_STALE_SECONDS, 300),

  cookieName: env.CMS_COOKIE_NAME || "rahs_admin",
  csrfCookieName: "rahs_csrf",
  csrfHeaderName: "x-csrf-token",

  isVercel: env.VERCEL === "1" || env.CI === "1" || env.NODE_ENV === "production",
};

/** True when the request should be treated as running over a secure channel. */
export const isSecureRequest = (headers) => {
  const proto =
    headers["x-forwarded-proto"] || headers["x-forwarded-protocol"] || env.CMS_FORCE_SECURE_COOKIES || "";
  return String(proto).split(",")[0].trim() === "https" || flag(env.CMS_FORCE_SECURE_COOKIES, false);
};

/** Fail fast on a misconfigured production deployment instead of half-working. */
export const assertProductionConfig = () => {
  const problems = [];
  if (config.driver === "local" && config.isVercel && !config.allowLocalDriver) {
    problems.push("CMS_DRIVER=local is not allowed on Vercel unless CMS_ALLOW_LOCAL_DRIVER=1 is set.");
  }
  if (config.driver === "supabase") {
    if (!config.supabaseUrl) problems.push("SUPABASE_URL is not set.");
    const described = describeSupabaseKey(config.supabaseServiceRoleKey);
    if (!described.ok) problems.push(described.reason);
  }
  return problems;
};
