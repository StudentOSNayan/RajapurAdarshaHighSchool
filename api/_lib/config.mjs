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

export const config = {
  /**
   * "supabase" -> Postgres (via PostgREST) + Storage buckets. Production.
   * "local"    -> JSON file + folder on disk. Local development / offline demo only.
   */
  driver: env.CMS_DRIVER === "local" ? "local" : "supabase",

  /** Set to "1" to allow the local driver outside development (used by the dev server). */
  allowLocalDriver: flag(env.CMS_ALLOW_LOCAL_DRIVER, false),

  supabaseUrl: (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, ""),
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || "",

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
   * tells the teacher to send the rest in a second go. */
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

/** Read the `role` claim out of a Supabase JWT without verifying it (config sanity only). */
const keyRole = (key) => {
  const payload = String(key).split(".")[1];
  if (!payload) return "";
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role || "";
  } catch {
    return "";
  }
};

/** Fail fast on a misconfigured production deployment instead of half-working. */
export const assertProductionConfig = () => {
  const problems = [];
  if (config.driver === "local" && config.isVercel && !config.allowLocalDriver) {
    problems.push("CMS_DRIVER=local is not allowed on Vercel unless CMS_ALLOW_LOCAL_DRIVER=1 is set.");
  }
  if (config.driver === "supabase") {
    if (!config.supabaseUrl) problems.push("SUPABASE_URL is not set.");
    if (!config.supabaseServiceRoleKey) problems.push("SUPABASE_SERVICE_ROLE_KEY is not set.");
    else if (keyRole(config.supabaseServiceRoleKey) !== "service_role") {
      // The classic setup mistake is pasting the anon key here. Refuse early.
      problems.push(
        `SUPABASE_SERVICE_ROLE_KEY has role "${keyRole(config.supabaseServiceRoleKey) || "unknown"}" — it must be the secret service_role key.`,
      );
    }
  }
  return problems;
};
