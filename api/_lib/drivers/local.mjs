/* Local driver: the same query interface on top of a JSON file plus a folder of
 * uploads. Development and offline testing only — the API refuses to use it on
 * Vercel (see config.assertProductionConfig) because a serverless filesystem is
 * ephemeral and read-only in production.
 *
 * Why it exists: it lets the whole CMS (auth, CRUD, uploads, publish rules,
 * public feeds) be exercised and tested with no cloud account at all, and it is
 * the reference implementation the Supabase driver is checked against.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { config } from "../config.mjs";
import { HttpError } from "../http.mjs";

const DATA_DIR = process.env.CMS_LOCAL_DIR || path.join(process.cwd(), ".cms-data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");

const EMPTY = { tables: {}, meta: {} };

const matches = (row, condition) => {
  const value = row[condition.col];
  switch (condition.op) {
    case "eq":
      return String(value) === String(condition.value);
    case "in":
      return (condition.value ?? []).some((v) => String(value) === String(v));
    case "is":
      return condition.value === null ? value === null || value === undefined : value === condition.value;
    case "is_not":
      return condition.value === null ? !(value === null || value === undefined) : value !== condition.value;
    case "gt":
      return value != null && String(value) > String(condition.value);
    case "gte":
      return value != null && String(value) >= String(condition.value);
    case "lt":
      return value != null && String(value) < String(condition.value);
    case "lte":
      return value != null && String(value) <= String(condition.value);
    case "like":
      return String(value ?? "").toLowerCase().includes(String(condition.value).toLowerCase());
    default:
      throw new HttpError(400, "bad_query", "অনুরোধের ফিল্টার সঠিক নয়।");
  }
};

const compare = (a, b, order) => {
  for (const rule of order) {
    const av = a[rule.col];
    const bv = b[rule.col];
    const aNull = av === null || av === undefined;
    const bNull = bv === null || bv === undefined;
    if (aNull && bNull) continue;
    if (aNull) return rule.nullsFirst ? -1 : 1;
    if (bNull) return rule.nullsFirst ? 1 : -1;
    const left = av instanceof Date ? av.toISOString() : av;
    const right = bv instanceof Date ? bv.toISOString() : bv;
    if (left === right) continue;
    const result = String(left) < String(right) ? -1 : 1;
    return rule.dir === "asc" ? result : -result;
  }
  return 0;
};

export const createDriver = async (cfg = config) => {
  let queue = Promise.resolve();
  let state = null;

  const load = async () => {
    if (state) return state;
    try {
      state = JSON.parse(await fs.readFile(DB_FILE, "utf8"));
    } catch {
      state = structuredClone(EMPTY);
    }
    state.tables ??= {};
    return state;
  };

  const save = () => {
    queue = queue.then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs.rename(tmp, DB_FILE);
    });
    return queue;
  };

  const table = (name) => {
    const db = state;
    db.tables[name] ??= [];
    return db.tables[name];
  };

  const project = (row, select) => {
    if (!select?.length) return { ...row };
    const out = {};
    for (const column of select) if (row[column] !== undefined) out[column] = row[column];
    return out;
  };

  const runList = (rows, query) => {
    let list = rows.filter((row) => (query.where ?? []).every((condition) => matches(row, condition)));
    if (query.order?.length) list = [...list].sort((a, b) => compare(a, b, query.order));
    if (query.offset) list = list.slice(Number(query.offset));
    if (query.limit != null) list = list.slice(0, Number(query.limit));
    return list.map((row) => project(row, query.select));
  };

  return {
    name: "local",
    dataDir: DATA_DIR,

    async list(name, query) {
      await load();
      return runList(table(name), query);
    },

    async insert(name, row, returning) {
      await load();
      const now = new Date().toISOString();
      const created = { id: crypto.randomUUID(), created_at: now, updated_at: now, ...row };
      table(name).unshift(created);
      await save();
      return project(created, returning);
    },

    async update(name, id, patch, returning) {
      await load();
      const rows = table(name);
      const row = rows.find((candidate) => String(candidate.id) === String(id));
      if (!row) throw new HttpError(404, "not_found", "আইটেমটি খুঁজে পাওয়া যায়নি — হয়তো মুছে ফেলা হয়েছে।");
      Object.assign(row, patch, { updated_at: new Date().toISOString() });
      await save();
      return project(row, returning);
    },

    async remove(name, id) {
      await load();
      const rows = table(name);
      const index = rows.findIndex((row) => String(row.id) === String(id));
      if (index < 0) throw new HttpError(404, "not_found", "আইটেমটি খুঁজে পাওয়া যায়নি।");
      rows.splice(index, 1);
      await save();
      return { id, purged: true };
    },

    async count(name, query) {
      await load();
      return runList(table(name), { ...query, limit: 1000 }).length;
    },

    async privileged(kind, spec) {
      await load();
      const rows = table(spec.table);
      const where = spec.where ?? [];
      const columns = spec.columns === "all" ? null : PRIV_COLUMNS[spec.table];
      const shape = (row) => (columns ? project(row, columns) : { ...row });

      switch (kind) {
        case "list":
          return runList(rows, { where, order: spec.order ?? [], limit: spec.limit }).map(shape);
        case "one": {
          const found = rows.filter((row) => where.every((condition) => matches(row, condition)))[0];
          return found ? shape(found) : null;
        }
        case "count":
          return rows.filter((row) => where.every((condition) => matches(row, condition))).length;
        case "insert": {
          const now = new Date().toISOString();
          const created = { id: crypto.randomUUID(), created_at: now, updated_at: now, ...spec.row };
          rows.unshift(created);
          await save();
          return shape(created);
        }
        case "update": {
          const row = spec.id
            ? rows.find((candidate) => String(candidate.id) === String(spec.id))
            : rows.find((candidate) => where.every((condition) => matches(candidate, condition)));
          if (!row) return null;
          Object.assign(row, spec.patch);
          await save();
          return shape(row);
        }
        case "delete": {
          const keep = (row) => !(where.length && where.every((condition) => matches(row, condition)));
          const before = rows.length;
          state.tables[spec.table] = spec.id ? rows.filter((row) => String(row.id) !== String(spec.id)) : rows.filter(keep);
          await save();
          return { ok: true, removed: before - state.tables[spec.table].length };
        }
        default:
          throw new HttpError(500, "bad_call", "অভ্যন্তরীণ ত্রুটি।");
      }
    },

    /* ------------------------------------------------------------ storage */
    media: {
      async put(filePath, body) {
        const target = path.join(MEDIA_DIR, filePath);
        if (!target.startsWith(MEDIA_DIR)) throw new HttpError(400, "bad_path", "ফাইলের পথ গ্রহণযোগ্য নয়।");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, body);
        return { path: filePath };
      },

      async exists(filePath) {
        try {
          await fs.stat(path.join(MEDIA_DIR, filePath));
          return true;
        } catch {
          return false;
        }
      },

      async remove(filePath) {
        try {
          await fs.unlink(path.join(MEDIA_DIR, filePath));
        } catch {
          /* already gone */
        }
      },

      async read(filePath, transform) {
        const target = path.join(MEDIA_DIR, filePath);
        if (!target.startsWith(MEDIA_DIR)) throw new HttpError(400, "bad_path", "ফাইলের পথ গ্রহণযোগ্য নয়।");
        try {
          const buffer = await fs.readFile(target);
          return { buffer, mime: MIME_BY_EXT[path.extname(target).toLowerCase()] || "application/octet-stream" };
        } catch {
          return null;
        }
      },
    },
  };
};

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

/** Read projections for the privileged tables (never hashes or raw tokens). */
const PRIV_COLUMNS = {
  cms_users: ["id", "email", "full_name", "role", "is_active", "last_login_at", "created_at", "updated_at"],
  cms_sessions: ["id", "user_id", "token_hash", "created_at", "expires_at"],
  cms_audit: ["id", "user_id", "user_email", "action", "entity", "entity_id", "detail", "created_at"],
};

export { moduleOnly as default } from "../guard.mjs";
