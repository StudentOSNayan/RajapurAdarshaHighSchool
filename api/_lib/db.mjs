/* Data access layer.
 *
 * One small query interface, two interchangeable drivers:
 *   supabase.mjs -> Postgres through the project's REST endpoint (production)
 *   local.mjs    -> JSON file on disk (local development / offline demo)
 *
 * The service-role key is only ever read from the server environment here; it is
 * never part of any response body. Column whitelists below stop mass-assignment:
 * a caller cannot inject `id`, `created_by`, `deleted_at`, a password hash, …
 */

import { config } from "./config.mjs";
import { badRequest, notFound } from "./http.mjs";

/** Columns a write request may set. Read-only/bookkeeping columns are excluded. */
export const WRITABLE = {
  notices: ["title", "body", "audience", "notice_type", "importance", "published_at", "status", "file_path", "file_name", "file_mime", "file_bytes"],
  exam_routines: ["exam_name", "class_name", "subject", "exam_date", "start_time", "room", "notes", "file_path", "file_name", "file_mime", "file_bytes", "sort_order", "published_at", "status"],
  routines: ["title", "routine_type", "class_name", "event_date", "start_time", "end_time", "description", "file_path", "file_name", "file_mime", "file_bytes", "published_at", "status"],
  albums: ["title", "description", "category", "album_date", "cover_photo_id", "published_at", "status"],
  photos: ["album_id", "file_path", "alt_text", "caption", "bytes", "mime", "pixel_width", "pixel_height", "sort_order"],
};

/** Columns safe to hand to a browser (never password hashes or session tokens). */
export const READABLE = {
  notices: ["id", ...WRITABLE.notices, "created_at", "updated_at", "deleted_at"],
  exam_routines: ["id", ...WRITABLE.exam_routines, "created_at", "updated_at", "deleted_at"],
  routines: ["id", ...WRITABLE.routines, "created_at", "updated_at", "deleted_at"],
  albums: ["id", ...WRITABLE.albums, "created_at", "updated_at", "deleted_at"],
  photos: ["id", ...WRITABLE.photos, "created_at", "updated_at", "deleted_at"],
};

const assertTable = (table) => {
  if (!Object.prototype.hasOwnProperty.call(READABLE, table)) throw badRequest(`অজানা টেবিল: ${table}`);
  return table;
};

const allow = (table, row) => {
  const allowed = new Set(WRITABLE[table]);
  const clean = {};
  for (const [key, value] of Object.entries(row || {})) if (allowed.has(key)) clean[key] = value ?? null;
  return clean;
};

export const CONTENT_TABLES = {
  notice: "notices",
  album: "albums",
  photo: "photos",
};

/** entity name (from the admin app / API) -> table + read projection */
export const ENTITIES = {
  notices: { table: "notices" },
  exams: { table: "exam_routines" },
  routines: { table: "routines" },
  albums: { table: "albums" },
  photos: { table: "photos" },
};

export class Store {
  constructor(driver) {
    this.driver = driver;
  }

  async list(table, query = {}) {
    assertTable(table);
    const where = [...(query.where ?? [])];
    // Trash is invisible everywhere unless a caller explicitly asks for it.
    if (!query.includeDeleted && !where.some((w) => w.col === "deleted_at")) {
      where.push({ col: "deleted_at", op: "is", value: null });
    }
    return this.driver.list(table, {
      where,
      order: query.order ?? [],
      limit: query.limit,
      offset: query.offset,
      select: READABLE[table],
      includeDeleted: Boolean(query.includeDeleted),
    });
  }

  /** Pass-through read for internal joins (photos of an album, counts). The
   *  caller owns the filters, so `deleted_at` must be stated explicitly. */
  async rawList(table, query) {
    if (!READABLE[table]) throw badRequest(`অজানা টেবিল: ${table}`);
    return this.driver.list(table, { ...query, select: query.select ?? READABLE[table] });
  }

  async one(table, where = []) {
    const rows = await this.list(table, { where, limit: 1 });
    return rows[0] ?? null;
  }

  async byId(table, id, { includeDeleted = false } = {}) {
    assertTable(table);
    const rows = await this.list(table, { where: [{ col: "id", op: "eq", value: id }], limit: 1, includeDeleted });
    if (!rows.length) throw notFound();
    return rows[0];
  }

  async insert(table, row) {
    assertTable(table);
    return this.driver.insert(table, allow(table, row), READABLE[table]);
  }

  async update(table, id, patch) {
    assertTable(table);
    const clean = allow(table, patch);
    if (!Object.keys(clean).length) throw badRequest("পরিবর্তনের জন্য কোনো ঘর পাওয়া যায়নি।");
    return this.driver.update(table, id, clean, READABLE[table]);
  }

  /** Trash: keeps the row, hides it everywhere. */
  async softDelete(table, id) {
    assertTable(table);
    return this.driver.update(table, id, { deleted_at: new Date().toISOString() }, READABLE[table]);
  }

  async restore(table, id) {
    assertTable(table);
    return this.driver.update(table, id, { deleted_at: null }, READABLE[table]);
  }

  /** Permanent removal — only ever called from an explicit, confirmed admin action. */
  async purge(table, id) {
    assertTable(table);
    return this.driver.remove(table, id);
  }

  async count(table, where = []) {
    assertTable(table);
    const conditions = [...where];
    if (!conditions.some((w) => w.col === "deleted_at")) conditions.push({ col: "deleted_at", op: "is", value: null });
    return this.driver.count(table, { where: conditions });
  }

  /* --------------------------- privileged tables (never via generic routes) */

  users = {
    // Login needs the hash, so this one read opts into the full column set.
    byEmail: (email) =>
      this.driver.privileged("one", { table: "cms_users", columns: "all", where: [{ col: "email", op: "eq", value: String(email).toLowerCase().trim() }] }),
    byId: (id) => this.driver.privileged("one", { table: "cms_users", where: [{ col: "id", op: "eq", value: id }] }),
    list: () => this.driver.privileged("list", { table: "cms_users", order: [{ col: "created_at", dir: "asc" }] }),
    count: () => this.driver.privileged("count", { table: "cms_users", where: [] }),
    insert: (row) => this.driver.privileged("insert", { table: "cms_users", row }),
    update: (id, patch) => this.driver.privileged("update", { table: "cms_users", id, patch }),
  };

  sessions = {
    create: (row) => this.driver.privileged("insert", { table: "cms_sessions", row }),
    byToken: (tokenHash) => this.driver.privileged("one", { table: "cms_sessions", where: [{ col: "token_hash", op: "eq", value: tokenHash }] }),
    drop: (tokenHash) => this.driver.privileged("delete", { table: "cms_sessions", where: [{ col: "token_hash", op: "eq", value: tokenHash }] }),
    dropForUser: (userId) => this.driver.privileged("delete", { table: "cms_sessions", id: undefined, where: [{ col: "user_id", op: "eq", value: userId }] }),
    prune: () => this.driver.privileged("delete", { table: "cms_sessions", where: [{ col: "expires_at", op: "lt", value: new Date().toISOString() }] }),
  };

  audit = {
    add: (row) => this.driver.privileged("insert", { table: "cms_audit", row }),
    recent: (limit = 20) => this.driver.privileged("list", { table: "cms_audit", order: [{ col: "created_at", dir: "desc" }], limit }),
  };
}

let instance = null;

export const getStore = async () => {
  if (instance) return instance;
  const problems = config.driver === "supabase" ? ["supabase"] : ["local"];
  if (problems[0] === "supabase") {
    const missing = [];
    if (!config.supabaseUrl) missing.push("SUPABASE_URL");
    if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (missing.length) {
      throw badRequest(`সার্ভার কনফিগারেশন অসম্পূর্ণ: ${missing.join(", ")} সেট করা নেই।`);
    }
  }
  const { createDriver } =
    config.driver === "local" ? await import("./drivers/local.mjs") : await import("./drivers/supabase.mjs");
  instance = new Store(await createDriver(config));
  return instance;
};

/** Test seam: lets the offline test suite swap in a fresh driver. */
export const setStore = (store) => {
  instance = store;
};

export { allow as writableColumns };

export { moduleOnly as default } from "./guard.mjs";
