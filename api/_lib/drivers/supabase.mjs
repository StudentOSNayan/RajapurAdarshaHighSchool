/* Supabase driver: Postgres through PostgREST, files through Supabase Storage.
 *
 * Deliberately dependency-free (plain fetch) so the Vercel build stays exactly
 * what it is today: static files + small Node functions — no install step, no
 * bundler, no native module. Node 18+ ships fetch; Vercel runs Node 20+.
 */

import { config, publicStorageKey } from "../config.mjs";
import { HttpError } from "../http.mjs";

/* Server-only tables and the columns that may leave the driver. Anything not
 * listed here (password hashes, raw session tokens) is filtered out on read. */
/** Exported only so tools/ can assert these columns exist in supabase/schema.sql. */
export const PRIVILEGED = {
  cms_users: {
    read: ["id", "email", "full_name", "role", "is_active", "last_login_at", "created_at", "updated_at"],
    all: ["id", "email", "full_name", "role", "password_hash", "is_active", "failed_attempts", "locked_until", "last_login_at", "created_at", "updated_at"],
  },
  cms_sessions: {
    read: ["id", "user_id", "token_hash", "created_at", "expires_at"],
    all: ["id", "user_id", "token_hash", "ip", "user_agent", "created_at", "expires_at"],
  },
  cms_audit: {
    read: ["id", "user_id", "user_email", "action", "entity", "entity_id", "detail", "created_at"],
    all: ["id", "user_id", "user_email", "action", "entity", "entity_id", "detail", "created_at"],
  },
};

const OPS = {
  eq: (col, value) => `${col}=eq.${encodeURIComponent(String(value))}`,
  in: (col, value) => `${col}=in.(${(value || []).map((v) => encodeURIComponent(String(v))).join(",")})`,
  is: (col, value) => `${col}=is.${value === null ? "null" : "not.null"}`,
  is_not: (col, value) => `${col}=not.is.${value === null ? "null" : "not.null"}`,
  gt: (col, value) => `${col}=gt.${encodeURIComponent(String(value))}`,
  gte: (col, value) => `${col}=gte.${encodeURIComponent(String(value))}`,
  lt: (col, value) => `${col}=lt.${encodeURIComponent(String(value))}`,
  lte: (col, value) => `${col}=lte.${encodeURIComponent(String(value))}`,
  like: (col, value) => `${col}=like.${encodeURIComponent(`*${String(value).replace(/[%_]/g, "")}*`)}`,
};

const orderParam = (order) =>
  order.map((o) => `${o.col}.${o.dir === "asc" ? "asc" : "desc"}.${o.nullsFirst ? "nullsfirst" : "nullslast"}`).join(",");

const buildQuery = ({ select, where = [], order = [], limit, offset }) => {
  const parts = [];
  if (select?.length) parts.push(`select=${select.join(",")}`);
  for (const condition of where) {
    const op = OPS[condition.op];
    if (!op) throw new HttpError(400, "bad_query", "অনুরোধের ফিল্টার সঠিক নয়।");
    parts.push(op(condition.col, condition.value));
  }
  if (order.length) parts.push(`order=${orderParam(order)}`);
  if (limit != null) parts.push(`limit=${Number(limit)}`);
  if (offset) parts.push(`offset=${Number(offset)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

export const createDriver = async (cfg = config) => {
  const base = cfg.supabaseUrl;
  const key = cfg.supabaseServiceRoleKey;
  const authHeaders = { apikey: key, Authorization: `Bearer ${key}` };

  const call = async (method, path, body, extraHeaders = {}) => {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: { ...authHeaders, "Content-Type": "application/json", Prefer: "return=representation", ...extraHeaders },
        ...(body === undefined ? {} : { body }),
        cache: "no-store",
      });
    } catch (error) {
      console.error("[cms] supabase unreachable", error?.cause?.code || error?.message);
      throw new HttpError(503, "db_unreachable", "ডেটাবেসে পৌঁছানো যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।");
    }
    const text = response.status === 204 ? "" : await response.text().catch(() => "");
    if (!response.ok) {
      const detail = text.slice(0, 500);
      console.error("[cms] supabase error", method, path, response.status, detail);
      const hint = /does not exist|Could not find the table|schema does not exist/i.test(detail)
        ? " প্রথমে supabase/schema.sql চালান।"
        : "";
      throw new HttpError(502, "db_error", `ডেটাবেসে সমস্যা হয়েছে।${hint}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, "db_error", "ডেটাবেসের উত্তর বোঝা যায়নি।");
    }
  };

  const asRows = (payload) => (payload == null ? [] : Array.isArray(payload) ? payload : [payload]);
  const pick = (columns, row) => {
    if (!row) return row;
    const clean = {};
    for (const column of columns) if (row[column] !== undefined) clean[column] = row[column];
    return clean;
  };

  return {
    name: "supabase",

    async list(table, query) {
      return asRows(await call("GET", `/rest/v1/${table}${buildQuery(query)}`));
    },

    async insert(table, row, returning) {
      const created = asRows(await call("POST", `/rest/v1/${table}?select=${returning.join(",")}`, JSON.stringify(row)))[0];
      if (!created) throw new HttpError(500, "db_error", "সংরক্ষিত হয়েছে কি না নিশ্চিত করা যায়নি।");
      return created;
    },

    async update(table, id, patch, returning) {
      const updated = asRows(await call("PATCH", `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=${returning.join(",")}`, JSON.stringify(patch)))[0];
      if (!updated) throw new HttpError(404, "not_found", "আইটেমটি খুঁজে পাওয়া যায়নি — হয়তো মুছে ফেলা হয়েছে।");
      return updated;
    },

    async remove(table, id) {
      await call("DELETE", `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`);
      return { id, purged: true };
    },

    async count(table, query) {
      return asRows(await call("GET", `/rest/v1/${table}${buildQuery({ ...query, select: ["id"], limit: 1000, offset: undefined })}`)).length;
    },

    /* Privileged access keeps password hashes and raw tokens inside the process.
     * Note: `byEmail` needs the hash, so it opts into `columns: "all"` explicitly. */
    async privileged(kind, spec) {
      const table = spec.table;
      const priv = PRIVILEGED[table];
      if (!priv) throw new HttpError(500, "bad_call", "অভ্যন্তরীণ ত্রুটি।");
      const columns = spec.columns === "all" ? priv.all : priv.read;
      const shape = (row) => pick(columns, row);
      const where = spec.where ?? [];
      const order = spec.order ?? [];

      switch (kind) {
        case "list":
          return asRows(await call("GET", `/rest/v1/${table}${buildQuery({ select: columns, where, order, limit: spec.limit })}`)).map(shape);
        case "one": {
          const row = asRows(await call("GET", `/rest/v1/${table}${buildQuery({ select: columns, where, order, limit: 1 })}`))[0];
          return row ? shape(row) : null;
        }
        case "count":
          return asRows(await call("GET", `/rest/v1/${table}${buildQuery({ select: ["id"], where, limit: 1000 })}`)).length;
        case "insert":
          return shape(asRows(await call("POST", `/rest/v1/${table}?select=${columns.join(",")}`, JSON.stringify(spec.row)))[0]);
        case "update": {
          const filter = spec.id
            ? `id=eq.${encodeURIComponent(spec.id)}`
            : where.map((c) => OPS[c.op](c.col, c.value)).join("&");
          const row = asRows(await call("PATCH", `/rest/v1/${table}?${filter}&select=${columns.join(",")}`, JSON.stringify(spec.patch)))[0];
          return row ? shape(row) : null;
        }
        case "delete": {
          const filter = spec.id ? `id=eq.${encodeURIComponent(spec.id)}` : where.map((c) => OPS[c.op](c.col, c.value)).join("&");
          if (!filter) throw new HttpError(400, "bad_call", "মুছে ফেলার শর্ত দিতে হবে।");
          await call("DELETE", `/rest/v1/${table}?${filter}`);
          return { ok: true };
        }
        default:
          throw new HttpError(500, "bad_call", "অভ্যন্তরীণ ত্রুটি।");
      }
    },

    /* ------------------------------------------------------------ storage */
    media: {
      async put(path, body, mime) {
        const response = await fetch(`${base}/storage/v1/object/${cfg.storageBucket}/${path}`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": mime, "x-upsert": "false" },
          body,
          cache: "no-store",
        });
        if (!response.ok) {
          console.error("[cms] storage upload failed", response.status, (await response.text().catch(() => "")).slice(0, 300));
          throw new HttpError(502, "upload_failed", "ফাইলটি সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।");
        }
        return { path };
      },

      /* A one-path, expiring grant for a browser to PUT into. The token *is* the
       * credential (Supabase: "Signed upload URLs can be used to upload files to the
       * bucket without further authentication"), so no service key, bucket policy or
       * general write permission is given to the client — only the right to create the
       * one staging object this request just allocated, until it expires. */
      async sign(path, { contentType = "application/octet-stream" } = {}) {
        let response;
        try {
          response = await fetch(`${base}/storage/v1/object/upload/sign/${cfg.storageBucket}/${path}`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: "{}",
            cache: "no-store",
          });
        } catch (error) {
          console.error("[cms] storage sign unreachable", error?.cause?.code || error?.message);
          throw new HttpError(503, "storage_unreachable", "স্টোরেজে পৌঁছানো যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।");
        }
        const text = await response.text().catch(() => "");
        if (!response.ok) {
          console.error("[cms] storage sign failed", response.status, text.slice(0, 300));
          throw new HttpError(502, "sign_failed", "স্টোরেজ থেকে আপলোডের অনুমতি পাওয়া যায়নি।");
        }
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          throw new HttpError(502, "sign_failed", "স্টোরেজের উত্তর বোঝা যায়নি।");
        }
        // Supabase has answered with a full URL and with a path under /storage/v1
        // depending on the version (and a proxy in between can hand back the path it
        // received, prefix and all), so accept any of them and land on one absolute URL.
        // Joining blindly would produce /storage/v1/storage/v1/… — a grant the browser
        // cannot use, which looks like a failed upload rather than a bad URL.
        const raw = String(payload?.url || payload?.signedURL || payload?.signedUrl || "");
        const relative = raw.replace(/^\/storage\/v1(?=\/)/, "");
        const uploadUrl = !relative ? "" : /^https?:\/\//i.test(relative) ? relative : `${base}/storage/v1${relative.startsWith("/") ? "" : "/"}${relative}`;
        let token = String(payload?.token || "");
        if (!token && uploadUrl) {
          try {
            token = new URL(uploadUrl).searchParams.get("token") || "";
          } catch {
            token = "";
          }
        }
        if (!uploadUrl || !token) throw new HttpError(502, "sign_failed", "স্টোরেজ আপলোডের ঠিকানা পাওয়া যায়নি।");
        const headers = { "content-type": contentType, "x-upsert": "false", "cache-control": "max-age=3600" };
        // Only when the project's gateway insists every storage request carries a key:
        // publicStorageKey() returns "" for anything that is not recognisably public.
        const publicKey = publicStorageKey();
        if (publicKey) Object.assign(headers, { apikey: publicKey, Authorization: `Bearer ${publicKey}` });
        return { method: "PUT", upload_url: uploadUrl, headers };
      },

      /** Size and type as storage recorded them, so an oversized file is refused before
       *  its bytes are pulled into the function. */
      async stat(path) {
        const response = await fetch(`${base}/storage/v1/object/info/${cfg.storageBucket}/${encodeURIComponent(path)}`, {
          headers: authHeaders,
          cache: "no-store",
        }).catch(() => null);
        if (!response?.ok) return null;
        const payload = await response.json().catch(() => null);
        if (!payload) return null;
        const meta = payload.metadata ?? payload ?? {};
        const bytes = meta.size ?? payload.size;
        return {
          ...(Number.isFinite(Number(bytes)) ? { bytes: Number(bytes) } : {}),
          ...(meta.mimetype || payload.mimetype ? { mime: meta.mimetype || payload.mimetype } : {}),
        };
      },

      /** One directory level under a prefix. Every caller must re-validate each key. */
      async list(prefix, limit = 200) {
        const response = await fetch(`${base}/storage/v1/object/list/${cfg.storageBucket}`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix, limit, offset: 0, sortBy: { column: "created_at", order: "asc" } }),
          cache: "no-store",
        }).catch(() => null);
        if (!response?.ok) return [];
        const payload = await response.json().catch(() => null);
        return Array.isArray(payload) ? payload : [];
      },

      async exists(path) {
        const response = await fetch(`${base}/storage/v1/object/info/${cfg.storageBucket}/${encodeURIComponent(path)}`, {
          headers: authHeaders,
          cache: "no-store",
        });
        return response.ok;
      },

      async remove(path) {
        await fetch(`${base}/storage/v1/object/${cfg.storageBucket}`, {
          method: "DELETE",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: [path] }),
          cache: "no-store",
        });
      },

      /* Bytes for the /api/media route. With `transform` we ask Supabase's image
       * renderer for a resized WebP thumbnail; any failure falls back to the
       * original file so a picture can never appear broken. */
      async read(path, transform) {
        const get = async (url) => {
          const response = await fetch(url, { headers: authHeaders, cache: "force-cache" });
          if (!response.ok) return null;
          return { buffer: Buffer.from(await response.arrayBuffer()), mime: response.headers.get("content-type") || "application/octet-stream" };
        };
        if (transform) {
          const params = new URLSearchParams({
            width: String(transform.width),
            height: String(transform.height),
            resize: "cover",
            quality: String(transform.quality),
            format: "webp",
          });
          const rendered = await get(`${base}/storage/v1/render/image/authenticated/${cfg.storageBucket}/${path}?${params}`);
          if (rendered?.buffer?.length) return rendered;
        }
        return get(`${base}/storage/v1/object/${cfg.storageBucket}/${path}`);
      },
    },
  };
};

export { moduleOnly as default } from "../guard.mjs";
