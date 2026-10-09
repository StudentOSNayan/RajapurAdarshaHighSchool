/* The API surface. One router, used by the Vercel function files under /api and by
 * the local dev server alike, so what you test locally is what runs in production.
 *
 * Guards, in order, for every state-changing call:
 *   valid session cookie  →  CSRF token match  →  role check  →  field validation.
 * Reads of unpublished content require a session too; the public endpoints are a
 * separate, smaller surface that only ever returns published rows.
 */

import { config, assertProductionConfig } from "./config.mjs";
import {
  badRequest,
  forbidden,
  json,
  noStore,
  parseCookies,
  readBody,
  readJson,
  requestOrigin,
  fail,
  notFound,
  HttpError,
  clearCookies,
} from "./http.mjs";
import { getStore } from "./db.mjs";
import { SCHEMA, validate } from "./validate.mjs";
import {
  RESOURCES,
  addPhotoRecord,
  create,
  dashboardCounts,
  listForAdmin,
  movePhoto,
  purge,
  purgePhoto,
  publicAlbum,
  publicExams,
  publicGallery,
  publicNotices,
  publicRoutines,
  readOne,
  restore,
  setStatus,
  trash,
  trashPhoto,
  update,
  updatePhoto,
} from "./content.mjs";
import { acceptUpload, beginStagedUpload, commitStagedUpload, discardStagedUpload, mediaUrl, sweepStagedUploads, thumbTransform } from "./media.mjs";
import { bootstrap, changePassword, currentUser, endSession, hashPassword, login, publicUser, requireUser, requireAdminRole } from "./auth.mjs";
import { parseMultipart } from "./multipart.mjs";

const RESOURCES_LIST = Object.keys(RESOURCES);

/* ------------------------------------------------------------------- helpers */

const parseUrl = (req) => new URL(req.url, "http://internal.local");

const sendResult = (res, result, req) => {
  if (result?.raw) {
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }
  // Node accepts an array value for Set-Cookie straight through writeHead.
  json(res, result?.status ?? 200, result?.body ?? { ok: true }, { ...(result?.headers ?? {}), ...noStore(), "X-Robots-Tag": "noindex, nofollow" });
};

/** Session required for everything under /api/cms except the four public routes. */
const PUBLIC_CMS_PATHS = new Set(["status", "login", "logout", "setup"]);

/* -------------------------------------------------------------- admin routes */

const accounts = {
  async list(actor) {
    const rows = await actor.store.users.list();
    return { ok: true, accounts: rows.map((row) => ({ id: row.id, email: row.email, fullName: row.full_name, role: row.role, isActive: row.is_active !== false, lastLoginAt: row.last_login_at, createdAt: row.created_at })) };
  },
  async create(actor, body) {
    const clean = validate("account", body);
    const password = clean.password;
    delete clean.password;
    if (await actor.store.users.byEmail(clean.email)) throw badRequest("এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে।", { email: "ইমেইলটি ব্যবহৃত হচ্ছে।" });
    const created = await actor.store.driver.privileged("insert", {
      table: "cms_users",
      row: { ...clean, password_hash: hashPassword(password), is_active: true },
    });
    await actor.store.audit.add({ user_id: actor.user.id, user_email: actor.user.email, action: "account_create", entity: "cms_users", entity_id: created?.id, detail: clean.email });
    return { ok: true, account: { id: created?.id, email: created?.email, role: created?.role } };
  },
  async update(actor, id, patch) {
    const clean = validate("account", patch, { partial: true });
    if ("is_active" in patch) clean.is_active = Boolean(patch.is_active);
    if ("email" in clean && (await actor.store.users.byEmail(clean.email))) {
      throw badRequest("ইমেইলটি অন্য অ্যাকাউন্টে ব্যবহৃত হচ্ছে।", { email: "ব্যবহৃত হচ্ছে।" });
    }
    if (clean.password) {
      clean.password_hash = hashPassword(clean.password);
      clean.failed_attempts = 0;
      clean.locked_until = null;
    }
    delete clean.password;
    if (!Object.keys(clean).length) throw badRequest("পরিবর্তনের মতো কিছু পাওয়া যায়নি।");
    const target = await actor.store.users.byId(id);
    if (!target) throw notFound("অ্যাকাউন্ট খুঁজে পাওয়া যায়নি।");
    if (target.id === actor.user.id && (clean.is_active === false || (clean.role && clean.role !== "admin"))) {
      throw badRequest("নিজের অ্যাকাউন্ট নিষ্ক্রিয় বা ভূমিকা কমানো যাবে না।");
    }
    await actor.store.driver.privileged("update", { table: "cms_users", id, patch: clean });
    if ("password" in clean) await actor.store.sessions.dropForUser(id).catch(() => null);
    await actor.store.audit.add({ user_id: actor.user.id, user_email: actor.user.email, action: "account_update", entity: "cms_users", entity_id: id, detail: Object.keys(clean).join(",") });
    return { ok: true };
  },
};

async function handleCmsRoute(req, res, segments, query) {
  const head = segments[0] ?? "";
  /*
   * An action is a query parameter (`POST /api/cms/notices?action=publish&id=…`).
   * Vercel's zero-config function routing maps /api/<group>/<one segment> onto this
   * file and nothing deeper, so a sub-path like /api/cms/notices/publish never reaches
   * this handler on a real deployment — it 404s as a static miss before any code runs.
   * The older `/resource/action` form is still accepted (first wins above) so nothing
   * that already exists breaks; tools/test-api-routes.mjs keeps the single-segment rule.
   */
  const action = segments[1] || query.get("action") || "";

  /* ---- unauthenticated ---- */
  if (head === "status") {
    const store = await getStore().catch(() => null);
    const users = store ? await store.users.count().catch(() => null) : null;
    return {
      body: {
        ok: true,
        api: "rahs-cms",
        driver: config.driver,
        setupConfigured: users !== null && users > 0,
        needsSetup: users === 0,
        setupUnlocked: String(process.env.CMS_ALLOW_SETUP || "") === "1",
        limits: { maxImageMb: Math.round(config.maxImageBytes / 1024 / 1024), maxDocumentMb: Math.round(config.maxDocumentBytes / 1024 / 1024), maxImagesPerUpload: config.maxImagesPerUpload, directUploads: config.directUploads },
        configProblems: assertProductionConfig(),
      },
    };
  }
  if (head === "login" && req.method === "POST") return login(req, await readJson(req));
  if (head === "setup" && req.method === "POST") return bootstrap(req, await readJson(req));
  if (head === "logout" && req.method === "POST") {
    const store = await getStore().catch(() => null);
    const token = parseCookies(req)[config.cookieName];
    if (store && token) await endSession(store, token);
    return { body: { ok: true, loggedOut: true }, headers: { "Set-Cookie": clearCookies(req) } };
  }

  /* The one request in this API that carries file bytes without a session, and the
   * only reason it exists is the local driver: it has no signed URLs to hand out, so
   * this is its stand-in, which lets the whole direct-upload flow be exercised against
   * the real router (and the real media store) in development and in tests. The Supabase
   * driver never comes here — the browser PUTs straight to its signed URL.
   *
   * Deliberately ahead of requireUser: the grant itself is the credential, exactly like
   * a Supabase signed URL, so no CMS cookie and no CSRF token ride along. It is confined
   * to the single staging key it was minted for and to one use. */
  if (head === "photos" && action === "put" && req.method === "PUT") {
    if (config.driver !== "local") throw new HttpError(400, "not_supported", "সরাসরি আপলোড শুধু স্থানীয় সার্ভারে এই ঠিকানা দিয়ে চলে — Supabase সরাসরি তার স্বাক্ষরিত ঠিকানায় ফাইল নেয়।");
    if (req.headers.origin && req.headers.origin !== requestOrigin(req)) {
      throw forbidden("Cross-site request ব্লক করা হয়েছে।");
    }
    const token = String(query.get("token") || "");
    if (!/^[0-9a-f]{24,64}$/.test(token)) throw new HttpError(400, "bad_token", "আপলোডের টোকেনটি সঠিক নয়।");
    /* Bounded by the platform's own ceiling rather than the app's 8 MB, so a test can
     * never pass a request locally that the deployment would have rejected first. */
    const buffer = await readBody(req, config.maxFormBytes);
    return { status: 201, body: await (await getStore()).driver.media.acceptPut(token, buffer) };
  }

  /* ---- everything below needs a live session ---- *
   * The session is resolved first (anonymous callers get 401, never 403), then
   * requireUser layers on the origin + CSRF checks for state-changing calls. */
  const actor = await requireUser(req, { csrf: isMutatingMethod(req.method) });

  if (head === "session") return { body: { ok: true, user: publicUser(actor.user), csrfToken: actor.csrf } };
  if (head === "schema") return { body: { ok: true, schema: SCHEMA, resources: RESOURCES_LIST } };
  if (head === "dashboard") return { body: { ok: true, ...(await dashboardCounts(actor)) } };
  if (head === "password" && req.method === "POST") return { body: await changePassword(req, actor, await readJson(req)) };
  if (head === "audit" && req.method === "GET") {
    requireAdminRole(actor);
    return { body: { ok: true, entries: await actor.store.audit.recent(Math.min(Number(query.get("limit")) || 30, 100)) } };
  }
  if (head === "accounts") {
    requireAdminRole(actor);
    const id = query.get("id");
    if (req.method === "GET") return { body: await accounts.list(actor) };
    if (req.method === "POST" && !id) return { status: 201, body: await accounts.create(actor, await readJson(req)) };
    if (["PATCH", "POST"].includes(req.method) && id) return { body: await accounts.update(actor, id, await readJson(req)) };
    throw badRequest("এই পদ্ধতিটি এই ঠিকানায় চলে না।");
  }

  /* ---- direct uploads: allocate a staging key, then adopt what landed in it ----
   * Both calls are tiny JSON, which is the point: a photo bigger than the platform's
   * request-body ceiling cannot be carried by this function at all, so its bytes travel
   * browser → storage instead and only the key comes back here. Nothing is registered
   * until the bytes that actually arrived have been read back and put through the same
   * sniffing a form upload gets; the staging object is deleted whichever way that goes. */
  if (head === "photos" && action === "begin" && req.method === "POST") {
    const payload = await readJson(req);
    const result = await beginStagedUpload({ name: String(payload?.name ?? ""), size: Number(payload?.size) || 0 });
    /* Objects a closed tab left behind are cleared before this answer goes out: an
     * awaited sweep is the difference between "staging is eventually tidy" and a bucket
     * that quietly fills up. It never fails an upload — a storage listing that throws is
     * simply a sweep that did nothing this time. */
    if (result.supported) await sweepStagedUploads(actor.store).catch(() => 0);
    // 201 only when a staging object really came into being; a polite "this server
    // cannot do that" is an ordinary 200 the caller falls back from.
    return result.supported ? { status: 201, body: result } : { body: result };
  }
  if (head === "photos" && action === "commit" && req.method === "POST") {
    const payload = await readJson(req);
    const albumId = String(payload?.album_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(albumId)) throw badRequest("অ্যালবাম নির্বাচন করা হয়নি।");
    const record = await commitStagedUpload(String(payload?.staging_key ?? ""), { name: String(payload?.name ?? "") });
    const photo = await addPhotoRecord(albumId, { ...record, alt: String(payload?.alt ?? "").trim() || null }, actor);
    return { status: 201, body: { ok: true, photo } };
  }
  if (head === "photos" && action === "abort" && req.method === "POST") {
    const payload = await readJson(req);
    return { body: { ok: true, removed: await discardStagedUpload(String(payload?.staging_key ?? "")) } };
  }

  /* ---- uploads (multipart) ---- */
  if (head === "upload" && req.method === "POST") {
    const parts = await parseMultipart(req, config.maxFormBytes);
    const file = parts.files.find((candidate) => candidate.field === "file");
    if (!file) throw badRequest("কোনো ফাইল পাওয়া যায়নি।");
    const record = await acceptUpload(file);
    return { status: 201, body: { ok: true, file: { ...record, url: mediaUrl(record.path) }, thumbUrl: mediaUrl(record.path, thumbTransform()) } };
  }
  if (head === "photos" && action === "upload" && req.method === "POST") {
    const parts = await parseMultipart(req, config.maxFormBytes);
    const albumId = String(parts.fields.album_id ?? query.get("album_id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(albumId)) throw badRequest("অ্যালবাম নির্বাচন করা হয়নি।");
    const images = parts.files.filter((file) => file.field === "files" || file.field === "file");
    if (!images.length) throw badRequest("কোনো ছবি পাওয়া যায়নি।");
    if (images.length > config.maxImagesPerUpload) throw badRequest(`একবারে সর্বোচ্চ ${config.maxImagesPerUpload}টি ছবি দেওয়া যাবে।`);
    const altText = String(parts.fields.alt_text ?? "").trim() || null;
    const created = [];
    const failures = [];
    for (const file of images) {
      try {
        const record = await acceptUpload(file);
        /* No position is passed in: the album's next slot is counted from what is
         * already stored, so a retry or a second batch cannot collide. */
        created.push(await addPhotoRecord(albumId, { ...record, alt: altText }, actor));
      } catch (error) {
        if (error instanceof HttpError) failures.push({ name: file.filename, message: error.message });
        else throw error;
      }
    }
    if (!created.length) throw badRequest(failures[0]?.message || "কোনো ছবি আপলোড করা যায়নি।", undefined);
    return { status: 201, body: { ok: true, photos: created, failed: failures } };
  }
  if (head === "photos" && action && !RESOURCES_LIST.includes(action)) {
    const body = action === "delete" ? null : await readJson(req).catch(() => ({}));
    const id = String(body?.id ?? query.get("id") ?? "");
    if (action === "update") return { body: { ok: true, photo: await updatePhoto(id, body, actor) } };
    if (action === "move") return { body: await movePhoto(id, body?.direction === "up" ? "up" : "down", actor) };
    if (action === "trash") return { body: await trashPhoto(id, actor) };
    if (action === "purge") return { body: await purgePhoto(id, actor, { confirm: body?.confirm ?? query.get("confirm") }) };
    throw notFound();
  }

  /* ---- content resources ---- */
  const resource = segments[0];
  if (!RESOURCES_LIST.includes(resource)) throw notFound("এই API পাথটি চেনা যায়নি।");
  const id = query.get("id");
  const method = req.method.toUpperCase();

  if (!action) {
    if (method === "GET") {
      if (id) return { body: { ok: true, item: await readOne(resource, id) } };
      return {
        body: {
          ok: true,
          items: await listForAdmin(resource, {
            status: query.get("status") || undefined,
            search: query.get("q") || undefined,
            deleted: query.get("deleted") === "1",
            limit: Math.min(Number(query.get("limit")) || 100, 200),
            offset: Math.max(Number(query.get("offset")) || 0, 0),
          }),
        },
      };
    }
    if (method === "POST") return { status: 201, body: { ok: true, item: await create(resource, await readJson(req), actor) } };
    if (method === "PATCH" && id) return { body: { ok: true, item: await update(resource, id, await readJson(req), actor) } };
    throw badRequest("এই পদ্ধতিটি এই ঠিকানায় চলে না।");
  }

  if (method !== "POST" && method !== "PATCH") throw badRequest("এই কাজটি POST এ করতে হবে।");
  const body = await readJson(req).catch(() => ({}));
  const target = id ?? body.id;
  if (!target) throw badRequest("আইটেমের আইডি প্রয়োজন।");
  switch (action) {
    case "publish":
      return { body: { ok: true, item: await setStatus(resource, target, "published", actor) } };
    case "unpublish":
      return { body: { ok: true, item: await setStatus(resource, target, "unpublished", actor) } };
    case "draft":
      return { body: { ok: true, item: await setStatus(resource, target, "draft", actor) } };
    case "trash":
      return { body: await trash(resource, target, actor) };
    case "restore":
      return { body: await restore(resource, target, actor) };
    case "purge":
      return { body: await purge(resource, target, actor, { confirm: body.confirm ?? query.get("confirm") }) };
    default:
      throw notFound();
  }
}

const isMutatingMethod = (method) => !["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());

/* -------------------------------------------------------------- public routes */

/** The two paging parameters a list feed understands, exactly as the browser sent them. */
const pageQuery = (query) => ({ limit: query.get("limit"), offset: query.get("offset") });

async function handlePublicRoute(req, res, segments, query) {
  const head = segments[0] ?? "";
  // Same-origin only, and cached at the edge: a school site gets thousands of views
  // of the same list, so the database is hit at most once a minute.
  const headers = { "Cache-Control": `public, s-maxage=${config.publicCacheSeconds}, stale-while-revalidate=${config.publicCacheStaleSeconds}`, "X-Robots-Tag": "noindex" };
  switch (head) {
    // Each list answers with one page plus has_more/next_offset, so a page can offer the
    // older rows instead of leaving them unpublished-looking. The rows themselves are the
    // same shape they always were, and the first page is the same page it always was.
    case "notices":
      return { body: { ok: true, ...(await publicNotices(pageQuery(query))) }, headers };
    case "exams":
    case "exam-routines":
      return { body: { ok: true, ...(await publicExams(pageQuery(query))) }, headers };
    case "routines":
      return { body: { ok: true, ...(await publicRoutines(pageQuery(query))) }, headers };
    case "gallery":
      return {
        body: {
          ok: true,
          albums: await publicGallery({ albums: query.get("albums"), perAlbum: Number(query.get("per_album")) || 8 }),
        },
      };
    case "album": {
      const id = query.get("id");
      if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) throw badRequest("অ্যালবামের আইডি প্রয়োজন।");
      return { body: { ok: true, album: await publicAlbum(id) }, headers };
    }
    case "health":
      return { body: { ok: true, driver: config.driver, configProblems: assertProductionConfig() }, headers };
    default:
      throw notFound("এমন কোনো পাবলিক ফিড নেই।");
  }
}

/* ---------------------------------------------------------------- media route */

/**
 * Serves one stored object. Draft files stay private because this route only
 * hands out media that a published row references, or that the caller's session
 * is allowed to see (their own drafts) — guessing a UUID is not enough.
 */
async function handleMediaRoute(req, res, segments, query) {
  // /api/media?path=images/2026-10/<uuid>.jpg — the key travels in the query string
  // because the entry file is api/media.mjs, which Vercel maps to exactly /api/media.
  // The segments fallback only ever fires on the local dev server (which mounts the
  // handler by prefix); the same strict pattern below validates either form.
  const key = query.get("path") || segments.join("/");
  if (!/^(images|docs)\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif|pdf)$/.test(key)) {
    throw badRequest("ফাইলের ঠিকানা সঠিক নয়।");
  }
  const store = await getStore();
  // A file is world-readable only once a *published* row points at it; anything a
  // draft still references (or nothing at all) needs the admin session.
  if (!(await isPubliclyReferenced(store, key)) && !(await currentUser(req, store))) {
    throw forbidden("এই ফাইলটি এখনও প্রকাশিত হয়নি — দেখার অনুমতি নেই।");
  }
  const wantsTransform = Boolean(query.get("w"));
  const transform =
    wantsTransform && config.imageTransform && !key.endsWith(".pdf")
      ? { width: clampSize(query.get("w"), 64, 2000), height: clampSize(query.get("h"), 64, 2000), quality: clampSize(query.get("q"), 40, 95, config.thumbQuality) }
      : null;
  const found = await store.driver.media.read(key, transform);
  if (!found) throw notFound("ফাইলটি আর নেই।");
  return {
    raw: true,
    status: 200,
    body: found.buffer,
    headers: {
      "Content-Type": found.mime,
      "Cache-Control": `public, max-age=${config.imageTransform ? 86400 : 300}, s-maxage=604800, immutable`,
      "X-Robots-Tag": key.endsWith(".pdf") ? "noindex" : "all",
      "Cross-Origin-Resource-Policy": "same-origin",
      Vary: "Accept",
    },
  };
}

const clampSize = (value, min, max, fallback = 800) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const PUBLISHED = [{ col: "status", op: "eq", value: "published" }, { col: "deleted_at", op: "is", value: null }];

/** Does a published notice / routine / album-photo reference this object? */
const isPubliclyReferenced = async (store, key) => {
  for (const table of ["notices", "exam_routines", "routines"]) {
    const rows = await store
      .rawList(table, { where: [{ col: "file_path", op: "eq", value: key }, ...PUBLISHED], select: ["id"], limit: 1 })
      .catch(() => []);
    if (rows.length) return true;
  }
  const photos = await store
    .rawList("photos", { where: [{ col: "file_path", op: "eq", value: key }, { col: "deleted_at", op: "is", value: null }], select: ["id", "album_id"], limit: 1 })
    .catch(() => []);
  if (!photos.length) return false;
  const albums = await store
    .rawList("albums", { where: [{ col: "id", op: "eq", value: photos[0].album_id }, ...PUBLISHED], select: ["id"], limit: 1 })
    .catch(() => []);
  return albums.length > 0;
};

/* ------------------------------------------------------------------ entrypoints */

const dispatch = async (req, res, prefix, handler) => {
  const url = parseUrl(req);
  const segments = decodeURIComponent(url.pathname).replace(prefix, "").split("/").filter(Boolean);
  try {
    if (req.method === "OPTIONS") {
      json(res, 204, undefined, noStore());
      return;
    }
    const result = await handler(req, res, segments, url.searchParams);
    sendResult(res, result ?? { body: { ok: true } }, req);
  } catch (error) {
    fail(res, error, req);
  }
};

export const handleCms = (req, res) => dispatch(req, res, "/api/cms", handleCmsRoute);
export const handlePublic = (req, res) => dispatch(req, res, "/api/public", handlePublicRoute);
export const handleMedia = (req, res) => dispatch(req, res, "/api/media", handleMediaRoute);

export { moduleOnly as default } from "./guard.mjs";
