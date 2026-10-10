#!/usr/bin/env node
/* The direct-to-storage upload flow, driven through the REAL Supabase driver.
 *
 * Why this suite exists next to the other two:
 *   - tools/selftest.mjs exercises begin/PUT/commit on the *local* driver, whose
 *     `action=put` route stands in for a signed URL;
 *   - tools/test-storage-direct.mjs checks the Supabase driver's requests against a
 *     stubbed `fetch` inside the same process;
 *   - this one removes both shortcuts. api/_lib/drivers/supabase.mjs runs unchanged —
 *     its real URL building, its real headers, its real fetch — against a throwaway
 *     HTTP server on loopback that answers with Supabase Storage's own contract (same
 *     paths, verbs, response shapes, status codes), with the app's real handlers served
 *     in-process. Rows go to a temp folder; "the bucket" is a Map.
 *
 * So the properties that matter are proven over sockets rather than against a stub
 * that agrees to whatever it is asked: a grant names exactly one key and one use; the
 * bytes reach storage without any session credential; commit registers what storage
 * actually holds; staging is emptied on every outcome; /api/media still enforces
 * publication; cleanup can never name a stored asset; a storage that cannot sign falls
 * back instead of failing the teacher's upload.
 *
 * What it cannot prove is Supabase's own behaviour — that its gateway accepts a
 * token-only PUT for a bucket with no anon policies, the bucket's configured
 * file_size_limit, and real CORS from a browser. Those need a project of their own;
 * see cms/SETUP.md. Nothing here can reach one: no host but 127.0.0.1 is contacted.
 *
 *   node tools/test-supabase-storage.mjs
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? ` — ${detail}` : ""}`);
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (error) {
    record(name, false, error?.message || String(error));
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const BUCKET = "media";
const SERVICE_KEY = "sb_secret_loopback_contract_test_0000000000000000";
const STAGING_KEY = /^images\/incoming\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEDIA_KEY = /^images\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

/* ------------------------------------------------------- the fake storage service */

/**
 * Supabase Storage's HTTP surface, as this driver uses it:
 *   POST   /storage/v1/object/upload/sign/{bucket}/{key}            createSignedUploadUrl
 *   PUT    /storage/v1/object/upload/sign/{bucket}/{key}?token=…   the browser's write
 *   POST   /storage/v1/object/{bucket}/{key}                        upload (x-upsert: false)
 *   GET    /storage/v1/object/info/{bucket}/{key}                   stat / exists
 *   POST   /storage/v1/object/list/{bucket}                         list under a prefix
 *   DELETE /storage/v1/object/{bucket}                              remove {prefixes:[…]}
 *   GET    /storage/v1/object/{bucket}/{key}                        the object's bytes
 *   GET    /storage/v1/render/image/authenticated/{bucket}/{key}    thumbnail render
 *
 * Strict where strictness *is* the contract (a token names one key and one use;
 * `x-upsert:false` makes an existing key a 409), unopinionated where policing would
 * hide a bug: it never rejects a leaked credential itself, so the assertions below are
 * what catches that, rather than a fake inventing a rule the real service lacks.
 */
const createFakeStorage = () => {
  const objects = new Map(); // key → { buffer, mime, updatedAt }
  const grants = new Map(); // token → { key, expiresAt, used }
  const calls = [];
  const settings = {
    signShape: "absolute", // | "relative" | "pathless" — the answers Supabase has used
    renderFails: false,
    breakSign: false,
    /**
     * Bucket limits, because Supabase applies them to a signed upload too: its
     * uploadSignedObject route calls the same uploadFromRequest() that reads
     * `file_size_limit` and `allowed_mime_types` off the bucket row, so the browser's
     * PUT can be refused by storage even though our own API said yes. With these set,
     * the fake refuses the way the real service does (EntityTooLarge / InvalidMimeType).
     */
    fileSizeLimit: 0, // 0 = unlimited, like a bucket created without one
    allowedMimeTypes: [], // empty = no restriction
  };
  let port = 0;

  /** Supabase's own refusal shapes, so the copy this app shows is tested against them. */
  const refusal = (status, code, message) => ({ status, payload: { statusCode: String(status), error: code, message } });
  const checkBucketRules = (contentType, size, key, exists) => {
    if (exists) return refusal(409, "Duplicate", "The resource already exists");
    if (settings.fileSizeLimit > 0 && size > settings.fileSizeLimit) {
      return refusal(413, "EntityTooLarge", `Max size allowed has been exceeded, please try again with a smaller file (limit ${settings.fileSizeLimit} bytes)`);
    }
    if (settings.allowedMimeTypes.length && !settings.allowedMimeTypes.includes(contentType)) {
      return refusal(400, "InvalidMimeType", `${contentType} is not an allowed MIME type`);
    }
    return null;
  };

  const keyFrom = (segs, from) => segs.slice(from).join("/");
  const find = (predicate) => calls.filter(predicate);
  const stamp = () => new Date().toISOString();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const pathname = decodeURIComponent(url.pathname);
    const entry = {
      method: req.method,
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      bytes: body.length,
      body: body.toString("utf8"),
    };
    calls.push(entry);

    const send = (status, payload, headers = {}) => {
      const text = typeof payload === "string" ? payload : payload === undefined ? "" : JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(text);
    };
    const bytes = (buffer, mime) => {
      res.writeHead(200, { "content-type": mime, "content-length": String(buffer.length) });
      res.end(buffer);
    };
    const withServiceKey = req.headers.apikey === SERVICE_KEY || req.headers.authorization === `Bearer ${SERVICE_KEY}`;

    if (!pathname.startsWith("/storage/v1/")) return send(404, { error: "not_a_storage_route" });
    const segs = pathname.slice("/storage/v1/".length).split("/");
    const isSign = segs[0] === "object" && segs[1] === "upload" && segs[2] === "sign";
    const bucket = isSign ? segs[3] : segs[1];
    const key = isSign ? keyFrom(segs, 4) : keyFrom(segs, 2);

    /* ---- createSignedUploadUrl ---- */
    if (isSign && req.method === "POST") {
      if (settings.breakSign) return send(500, { error: { message: "storage is having a day" } });
      if (bucket !== BUCKET) return send(404, { error: { message: "Bucket not found" } });
      if (!withServiceKey) return send(400, { error: { message: "Failed to authenticate the request" } });
      // The endpoint takes no body. Anything in it — an expiresIn, say — is a mistake
      // worth failing on rather than quietly accepting.
      if (entry.body && entry.body !== "{}") return send(400, { error: { message: `unexpected body: ${entry.body}` } });
      if (objects.has(key)) return send(409, { error: { message: "The resource already exists" } });
      const token = crypto.randomBytes(16).toString("hex");
      grants.set(token, { key, expiresAt: Date.now() + 2 * 3600 * 1000, used: false });
      const suffix = `/object/upload/sign/${bucket}/${key}?token=${token}`;
      if (settings.signShape === "absolute") return send(200, { url: `http://127.0.0.1:${port}/storage/v1${suffix}`, token });
      if (settings.signShape === "relative") return send(200, { signedURL: `/storage/v1${suffix}`, token });
      return send(200, { signedURL: suffix, token });
    }

    /* ---- the browser's write, authorised by the token alone ---- */
    if (isSign && req.method === "PUT") {
      const token = url.searchParams.get("token") || "";
      const grant = grants.get(token);
      if (!grant) return send(400, { error: { message: "Invalid token" } });
      if (grant.used) return send(400, { error: { message: "Token already used" } });
      if (grant.expiresAt < Date.now()) return send(400, { error: { message: "Token has expired" } });
      if (grant.key !== key) return send(403, { error: { message: "Token is not valid for this path" } });
      const refused = checkBucketRules(req.headers["content-type"] || "application/octet-stream", body.length, key, objects.has(key));
      if (refused) return send(refused.status, refused.payload); // the token stays usable: nothing was written
      grant.used = true;
      objects.set(key, { buffer: body, mime: req.headers["content-type"] || "application/octet-stream", updatedAt: stamp() });
      return send(200, { Key: `object/${BUCKET}/${key}`, Id: crypto.randomUUID() });
    }
    if (segs[0] === "object" && segs[1] === "upload") return send(404, { error: "unexpected_upload_path" });

    /* ---- upload through the API ---- */
    if (segs[0] === "object" && req.method === "POST" && segs[1] !== "list") {
      if (bucket !== BUCKET) return send(404, { error: { message: "Bucket not found" } });
      if (!withServiceKey) return send(400, { error: { message: "Failed to authenticate" } });
      if (objects.has(key) && String(req.headers["x-upsert"]) !== "true") {
        return send(409, { error: { message: "The resource already exists" } });
      }
      // The same bucket rules apply to the API's own write of the final key.
      const refused = checkBucketRules(req.headers["content-type"] || "application/octet-stream", body.length, key, false);
      if (refused) return send(refused.status, refused.payload);
      objects.set(key, { buffer: body, mime: req.headers["content-type"] || "application/octet-stream", updatedAt: stamp() });
      return send(200, { Key: `object/${BUCKET}/${key}`, Id: crypto.randomUUID() });
    }

    /* ---- object info (what stat and exists read) ---- */
    if (segs[0] === "object" && segs[1] === "info") {
      const found = objects.get(keyFrom(segs, 3));
      if (!found) return send(400, { error: { message: "Object not found" } });
      return send(200, {
        name: found.name || keyFrom(segs, 3).split("/").pop(),
        bucket_id: BUCKET,
        id: crypto.randomUUID(),
        created_at: found.updatedAt,
        updated_at: found.updatedAt,
        last_accessed_at: found.updatedAt,
        metadata: { size: found.buffer.length, mimetype: found.mime },
      });
    }

    /* ---- list one prefix; names come back relative to the prefix, as Supabase sends ---- */
    if (segs[0] === "object" && segs[1] === "list") {
      let wanted = {};
      try {
        wanted = JSON.parse(entry.body || "{}");
      } catch {
        return send(400, { error: { message: "invalid json body" } });
      }
      const prefix = String(wanted.prefix || "");
      const limit = Number(wanted.limit) || 100;
      const rows = [...objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(([objectKey, value]) => ({
          name: prefix ? objectKey.slice(prefix.length) : objectKey,
          id: crypto.randomUUID(),
          updated_at: value.updatedAt,
          created_at: value.updatedAt,
          metadata: { size: value.buffer.length, mimetype: value.mime },
        }))
        .filter((row) => row.name.length > 0)
        .slice(0, limit);
      return send(200, rows);
    }

    /* ---- remove, by prefixes ---- */
    if (segs[0] === "object" && req.method === "DELETE") {
      const wanted = JSON.parse(entry.body || "{}");
      const removed = [];
      for (const prefix of wanted.prefixes ?? []) {
        for (const objectKey of [...objects.keys()]) {
          if (objectKey === prefix || objectKey.startsWith(`${prefix}/`)) {
            objects.delete(objectKey);
            removed.push({ name: objectKey });
          }
        }
      }
      return send(200, removed);
    }

    /* ---- the edge image renderer (thumbnails) ---- */
    if (segs[0] === "render") {
      const renderKey = keyFrom(segs, 4);
      const found = objects.get(renderKey);
      if (!found) return send(400, { error: { message: "Object not found" } });
      if (settings.renderFails) return send(500, { error: { message: "render failed" } });
      entry.renderParams = Object.fromEntries(url.searchParams);
      // A stand-in for a rendered WebP: different bytes, different type, so a check can
      // tell a rendered thumbnail from the original file.
      const params = entry.renderParams;
      // Written raw, not through send(): a rendered image is never JSON, and encoding it
      // as JSON is how a fake ends up agreeing to something the real service would not.
      const rendered = Buffer.from(`RENDERED ${params.width}x${params.height} q${params.quality} ${params.format} ${params.resize}`);
      res.writeHead(200, { "content-type": "image/webp", "content-length": String(rendered.length) });
      return res.end(rendered);
    }

    /* ---- the object's own bytes ---- */
    if (segs[0] === "object") {
      const found = objects.get(key);
      if (!found) return send(400, { error: { message: "Object not found" } });
      return bytes(found.buffer, found.mime);
    }

    return send(404, { error: "unhandled" });
  });

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve(port);
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    port: () => port,
    objects,
    settings,
    calls,
    find,
    clear: () => calls.splice(0, calls.length),
    /** Put an object in the bucket the way an earlier request would have, aged by
     *  hours so the sweep has something stale to find. */
    seed: (objectKey, content, { ageHours = 0 } = {}) =>
      objects.set(objectKey, {
        buffer: Buffer.from(content),
        mime: "application/octet-stream",
        updatedAt: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
      }),
  };
};

/* ------------------------------------------------------------- the app, in-process */

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-sb-storage-"));
const pngFile = path.join(ROOT, "file_000000007e208211b50fdcafeeae9f2e.png");

const storage = createFakeStorage();
const storagePort = await storage.listen();

/* Set before any app module is imported: config.mjs reads the environment once. */
process.env.CMS_DRIVER = "supabase";
process.env.CMS_STORAGE_BUCKET = BUCKET;
process.env.CMS_LOCAL_DIR = tempDir;
process.env.CMS_ALLOW_SETUP = "1";
process.env.SUPABASE_URL = `http://127.0.0.1:${storagePort}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const config = (await import("../api/_lib/config.mjs")).config;
const { Store, setStore } = await import("../api/_lib/db.mjs");
const localDriver = await (await import("../api/_lib/drivers/local.mjs")).createDriver(config);
const supabaseDriver = await (await import("../api/_lib/drivers/supabase.mjs")).createDriver(config);
/* Rows in the throwaway JSON store, every byte of media through the real Supabase
 * driver. This is the only arrangement in which the direct-upload flow can be driven
 * against a Supabase-shaped service without a Supabase project. */
setStore(new Store({ ...localDriver, media: supabaseDriver.media }));

const { handleCms, handlePublic, handleMedia } = await import("../api/_lib/router.mjs");
const app = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://127.0.0.1`);
  if (pathname.startsWith("/api/cms")) return handleCms(req, res);
  if (pathname.startsWith("/api/media")) return handleMedia(req, res);
  return handlePublic(req, res);
});
const appPort = await new Promise((resolve) => app.listen(0, "127.0.0.1", () => resolve(app.address().port)));
const BASE = `http://127.0.0.1:${appPort}`;

const jar = new Map();
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
const call = async (pathname, { method = "GET", body, headers = {}, raw = false } = {}) => {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(jar.get("rahs_csrf") && method !== "GET" ? { "x-csrf-token": jar.get("rahs_csrf") } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: BASE,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const [name, ...rest] = pair.split("=");
    if (pair.includes("Max-Age=0")) jar.delete(name);
    else jar.set(name, rest.join("="));
  }
  if (raw) return { status: response.status, headers: response.headers, buffer: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON answer is itself a finding; the caller asserts on the status */
  }
  return { status: response.status, json, text };
};

/** A real PNG padded to an exact size — what a phone's editor actually produces. */
const photoOf = async (bytes) => {
  const base = await fs.readFile(pngFile);
  return base.length >= bytes ? base.subarray(0, bytes) : Buffer.concat([base, Buffer.alloc(bytes - base.length, 0x5a)]);
};
/** What a browser does with a grant: put the file's bytes at the URL, nothing else. */
const putToBucket = async (grant, buffer) =>
  fetch(grant.upload_url, { method: grant.method || "PUT", headers: grant.headers, body: buffer });
const stagingKeys = () => [...storage.objects.keys()].filter((key) => STAGING_KEY.test(key));

/* ------------------------------------------------------------------------ run */

let albumId = "";
let staged = null;
/* How many photos this run legitimately committed. The orphan check compares the bucket
 * against this, so the assertion cannot drift as checks are added or removed. */
let committed = 0;

try {
  console.log("— the grant, over real HTTP —");

  await check("setup signs a test admin in against the in-process API", async () => {
    const { status, json } = await call("/api/cms/setup", {
      method: "POST",
      body: { email: "head@school.edu", full_name: "Computer Teacher", password: "bidyalaya-2026-test" },
    });
    assert(status === 201 || status === 200, `${status} ${JSON.stringify(json)}`);
    assert(jar.has("rahs_admin"), "no session cookie was set");
    const { json: statusJson } = await call("/api/cms/status");
    assert(statusJson.limits.directUploads === true, "status does not advertise direct uploads for a Supabase driver");
    assert(statusJson.configProblems.length === 0, `config problems on a Supabase driver: ${JSON.stringify(statusJson.configProblems)}`);
  });

  await check("a draft album is created in the throwaway store", async () => {
    const { status, json } = await call("/api/cms/albums", {
      method: "POST",
      body: { title: "সরাসরি আপলোড (চুক্তি পরীক্ষা)", category: "campus", published_at: "2026-12-01", status: "draft" },
    });
    assert(status === 201, `${status} ${JSON.stringify(json)}`);
    albumId = json.item.id;
  });

  await check("begin asks storage for a grant over HTTP, as a server should", async () => {
    storage.clear();
    const buffer = await photoOf(5_760_000);
    const { status, json } = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "edit-5-76.png", size: buffer.length } });
    assert(status === 201, `${status} ${JSON.stringify(json)}`);
    staged = { key: json.staging_key, grant: json, buffer };
    const sign = storage.find((entry) => entry.path.includes("/object/upload/sign/"))[0];
    assert(sign, `no sign call reached storage: ${JSON.stringify(storage.calls.map((entry) => [entry.method, entry.path]))}`);
    assert(sign.method === "POST", `the sign call was a ${sign.method}`);
    assert(sign.path === `/storage/v1/object/upload/sign/${BUCKET}/${json.staging_key}`, `unexpected sign path ${sign.path}`);
    assert(sign.body === "{}", `the sign call sent a body: ${JSON.stringify(sign.body)} — expiresIn is not Supabase's contract`);
    assert(sign.headers.authorization === `Bearer ${SERVICE_KEY}`, "the sign call was not authenticated as the service role");
    assert(STAGING_KEY.test(json.staging_key), `the key is not a staging key: ${json.staging_key}`);
  });

  await check("the grant points at storage and never back at the API", async () => {
    const url = new URL(staged.grant.upload_url);
    assert(url.port === String(storagePort), `the PUT would go to ${url.host}:${url.port} instead of storage`);
    assert(!/action=put/.test(staged.grant.upload_url), "the grant sent the file to the app's own endpoint");
    assert(url.searchParams.get("token"), `no token in ${staged.grant.upload_url}`);
    assert(staged.grant.method === "PUT", `the grant asked for a ${staged.grant.method}`);
    assert(staged.grant.headers["x-upsert"] === "false", "the grant would let an existing object be overwritten");
  });

  await check("nothing the server keeps secret is handed to the browser", async () => {
    const wire = JSON.stringify(staged.grant);
    assert(!wire.includes(SERVICE_KEY), "the service-role key was in the response");
    assert(!/service_role/i.test(wire), `a credential shape was in the response: ${wire}`);
    assert(!("apikey" in staged.grant.headers) && !("Authorization" in staged.grant.headers), "an authorisation header was sent without being configured");
    assert(wire.length < 600, `the grant response is ${wire.length} bytes for a key and a URL`);
  });

  console.log("\n— the PUT, then the commit —");

  await check("the browser's PUT carries the file and no session at all", async () => {
    storage.clear();
    const response = await putToBucket(staged.grant, staged.buffer);
    assert(response.status === 200, `storage answered ${response.status} ${await response.text().catch(() => "")}`);
    const put = storage.calls[0];
    assert(put.bytes === 5_760_000, `storage received ${put.bytes} bytes for a 5760000 byte file`);
    assert(!put.headers.cookie, "the CMS session cookie rode along to storage");
    assert(!put.headers["x-csrf-token"], "a CSRF token rode along to storage");
    assert(!put.headers.authorization && !put.headers.apikey, "a server credential rode along to storage");
    assert(put.headers["x-upsert"] === "false", "the write did not forbid overwriting an existing object");
    const stored = storage.objects.get(staged.key);
    assert(stored, "the staging key never appeared in the bucket");
    assert(Buffer.compare(stored.buffer, staged.buffer) === 0, "the bytes in the bucket are not the bytes that were sent");
  });

  await check("commit registers the photo from what storage actually holds", async () => {
    storage.clear();
    const { status, json } = await call("/api/cms/photos?action=commit", {
      method: "POST",
      body: { album_id: albumId, staging_key: staged.key, name: "edit-5-76.png" },
    });
    assert(status === 201, `${status} ${JSON.stringify(json)}`);
    const photo = json.photo;
    assert(photo.bytes === 5_760_000 && photo.mime === "image/png", `row: ${JSON.stringify({ bytes: photo.bytes, mime: photo.mime })}`);
    assert(photo.pixel_width > 0 && photo.pixel_height > 0, `dimensions not sniffed: ${photo.pixel_width}x${photo.pixel_height}`);
    const key = new URL(`${BASE}${photo.url}`).searchParams.get("path");
    assert(MEDIA_KEY.test(key), `the photo was stored at ${key}`);
    staged.finalKey = key;
    staged.photoId = photo.id;
    committed += 1;
    const paths = storage.calls.map((entry) => [entry.method, entry.path].join(" "));
    assert(storage.find((entry) => entry.method === "GET" && /\/object\/info\//.test(entry.path)).length === 1, `stat was not consulted exactly once: ${JSON.stringify(paths)}`);
    assert(storage.find((entry) => entry.method === "GET" && entry.path === `/storage/v1/object/${BUCKET}/${staged.key}`).length === 1, "the staged bytes were never read back");
    assert(storage.find((entry) => entry.method === "POST" && entry.path === `/storage/v1/object/${BUCKET}/${key}`).length === 1, "the final object was not written by the service role");
    assert(storage.find((entry) => entry.method === "DELETE" && entry.body.includes(staged.key)).length === 1, "staging was not emptied after a successful commit");
    assert(!storage.objects.has(staged.key), "the staging object survived in the bucket");
    assert(storage.objects.get(key).buffer.length === 5_760_000, "the stored photo is not the file that was uploaded");
  });

  await check("the album lists exactly the photo commit confirmed", async () => {
    const { json } = await call(`/api/cms/albums?id=${albumId}`);
    assert(json.item.photos.length === 1, `${json.item.photos.length} photos in the album`);
    assert(json.item.photos[0].id === staged.photoId, "a different row is in the album");
    assert(json.item.status === "draft", "the album should still be a draft");
  });

  console.log("\n— media access —");

  await check("a draft photo is not world-readable, but the admin can see it", async () => {
    const url = `/api/media?path=${encodeURIComponent(staged.finalKey)}`;
    const saved = new Map(jar);
    jar.clear();
    const anonymous = await call(url, { raw: true });
    jar.clear();
    for (const [name, value] of saved) jar.set(name, value);
    assert(anonymous.status === 403, `a draft photo served anonymously with ${anonymous.status}`);
    const owner = await call(url, { raw: true });
    assert(owner.status === 200 && owner.buffer.length === 5_760_000, `the admin got ${owner.status} / ${owner.buffer.length} bytes`);
  });

  await check("publishing makes it public, and the bytes are the uploaded ones", async () => {
    const { status } = await call(`/api/cms/albums?action=publish&id=${albumId}`, { method: "POST" });
    assert(status === 200, `publish → ${status}`);
    const saved = new Map(jar);
    jar.clear();
    const anonymous = await call(`/api/media?path=${encodeURIComponent(staged.finalKey)}`, { raw: true });
    jar.clear();
    for (const [name, value] of saved) jar.set(name, value);
    assert(anonymous.status === 200, `a published photo was not public (${anonymous.status})`);
    assert(Buffer.compare(anonymous.buffer, staged.buffer) === 0, "the bytes on the public site are not the bytes that were uploaded");
    const { json: feed } = await call("/api/public/gallery");
    const album = feed.albums.find((candidate) => candidate.id === albumId);
    assert(album?.photos?.length === 1, `the public gallery shows ${album?.photos?.length} photos`);
    assert(album.photos[0].full.startsWith("/api/media?path="), "the public feed handed out a storage URL instead of the site's own");
  });

  await check("a thumbnail is rendered by storage with the sizes this app configures", async () => {
    storage.clear();
    const thumb = await call(`/api/media?path=${encodeURIComponent(staged.finalKey)}&w=800&h=600&q=72`, { raw: true });
    assert(thumb.status === 200, `thumb → ${thumb.status}`);
    const render = storage.find((entry) => /\/render\/image\/authenticated\//.test(entry.path))[0];
    assert(render, `no render call was made: ${JSON.stringify(storage.calls.map((entry) => entry.path))}`);
    assert(render.path === `/storage/v1/render/image/authenticated/${BUCKET}/${staged.finalKey}`, `render path ${render.path}`);
    const params = render.renderParams;
    assert(params.width === "800" && params.height === "600" && params.quality === "72", `render params ${JSON.stringify(params)}`);
    assert(params.format === "webp" && params.resize === "cover", `render params ${JSON.stringify(params)}`);
    assert(thumb.buffer.subarray(0, 8).toString() === "RENDERED", "the response was not the rendered copy");
  });

  await check("a renderer failure falls back to the original file, never a broken image", async () => {
    storage.settings.renderFails = true;
    try {
      const thumb = await call(`/api/media?path=${encodeURIComponent(staged.finalKey)}&w=800&h=600`, { raw: true });
      assert(thumb.status === 200, `the fallback did not serve (${thumb.status})`);
      assert(thumb.buffer.length === 5_760_000, `the fallback served ${thumb.buffer.length} bytes`);
    } finally {
      storage.settings.renderFails = false;
    }
  });

  await check("a staging key has no URL at all — 400, not 403", async () => {
    const probe = "images/incoming/2026-12/deadbeef-0000-4000-8000-000000000000";
    storage.seed(probe, "half an upload");
    const { status, json } = await call(`/api/media?path=${encodeURIComponent(probe)}`);
    assert(status === 400, `staging answered ${status} ${JSON.stringify(json)}`);
    const anonymous = await (async () => {
      const saved = new Map(jar);
      jar.clear();
      const result = await call(`/api/media?path=${encodeURIComponent(probe)}`);
      jar.clear();
      for (const [name, value] of saved) jar.set(name, value);
      return result;
    })();
    assert(anonymous.status === 400, `a visitor could reach staging (${anonymous.status})`);
    storage.objects.delete(probe);
  });

  console.log("\n— what storage and the app refuse —");

  await check("a grant is valid for the one key it names, and only once", async () => {
    const first = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "one.png", size: 2048 } });
    const second = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "two.png", size: 2048 } });
    const token = new URL(first.json.upload_url).searchParams.get("token");
    const wrongPath = `http://127.0.0.1:${storagePort}/storage/v1/object/upload/sign/${BUCKET}/${second.json.staging_key}?token=${token}`;
    const rejected = await fetch(wrongPath, { method: "PUT", body: await photoOf(2048) });
    assert(rejected.status === 403, `a token wrote to a key it was not minted for (${rejected.status})`);
    assert(!storage.objects.has(second.json.staging_key), "the refused write still landed in the bucket");
    const accepted = await putToBucket(second.json, await photoOf(2048));
    assert(accepted.status === 200, `the rightful write failed (${accepted.status})`);
    const reused = await putToBucket(second.json, await photoOf(2048));
    assert(reused.status !== 200, `a used token was accepted again (${reused.status})`);
    for (const grant of [first.json, second.json]) {
      await call("/api/cms/photos?action=abort", { method: "POST", body: { staging_key: grant.staging_key } });
    }
    assert(stagingKeys().length === 0, `abort left staging behind: ${JSON.stringify(stagingKeys())}`);
  });

  await check("a non-image is refused after the PUT, and staging is emptied", async () => {
    const begin = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "trojan.png", size: 4096 } });
    assert(begin.status === 201, JSON.stringify(begin.json));
    await putToBucket(begin.json, Buffer.from("#!/bin/sh\nrm -rf /\n".repeat(80)));
    storage.clear();
    const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: "trojan.png" } });
    assert(commit.status === 415, `a script was registered (${commit.status})`);
    assert(storage.find((entry) => entry.method === "DELETE").length === 1, "the rejected object was left in the bucket");
    assert(!storage.objects.has(begin.json.staging_key), "staging still holds the rejected bytes");
    const { json } = await call(`/api/cms/albums?id=${albumId}`);
    assert(json.item.photos.length === 1, "a row appeared for a refused file");
  });

  await check("an oversized file is refused from the recorded size, before its bytes are pulled", async () => {
    const begin = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "huge.png", size: 1024 } });
    assert(begin.status === 201, JSON.stringify(begin.json));
    // The client lied about the size, so a grant was issued. The bytes say otherwise.
    await putToBucket(begin.json, await photoOf(30_000_000));
    storage.clear();
    const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: "huge.png" } });
    assert(commit.status === 413, `30 MB was accepted (${commit.status})`);
    assert(/8 MB/.test(String(commit.json?.message)), `the message did not name the limit: ${JSON.stringify(commit.json)}`);
    assert(!storage.find((entry) => entry.method === "GET" && entry.path === `/storage/v1/object/${BUCKET}/${begin.json.staging_key}`).length, "the function read 30 MB into memory before deciding");
    assert(!storage.objects.has(begin.json.staging_key), "the refused file is still in the bucket");
  });

  await check("a file too big for a grant is refused before any upload is wasted", async () => {
    const { status, json } = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "forty.png", size: 40_000_000 } });
    assert(status === 413, `${status}`);
    assert(/২০০০ পিক্সেল/.test(String(json?.message)), `no advice on resizing: ${JSON.stringify(json)}`);
    assert(stagingKeys().length === 0, "a refused begin still created a staging object");
  });

  await check("commit with nothing in staging registers nothing", async () => {
    const begin = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "never.png", size: 5_000_000 } });
    const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: "never.png" } });
    assert(commit.status === 404, `an empty staging key registered a photo (${commit.status})`);
    assert(/শেষ হয়নি|পাওয়া যায়নি/.test(String(commit.json?.message)), JSON.stringify(commit.json));
    const { json } = await call(`/api/cms/albums?id=${albumId}`);
    assert(json.item.photos.length === 1, "a row appeared for bytes that never arrived");
    await call("/api/cms/photos?action=abort", { method: "POST", body: { staging_key: begin.json.staging_key } });
  });

  await check("cleanup cannot name a stored asset", async () => {
    const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: staged.finalKey, name: "x.png" } });
    assert(commit.status === 400, `commit accepted a published key (${commit.status})`);
    const abort = await call("/api/cms/photos?action=abort", { method: "POST", body: { staging_key: staged.finalKey } });
    assert(abort.status === 200 && abort.json.removed === false, JSON.stringify(abort.json));
    assert(storage.objects.has(staged.finalKey), "a cleanup call removed the school's photo");
    const still = await call(`/api/media?path=${encodeURIComponent(staged.finalKey)}`, { raw: true });
    assert(still.status === 200 && still.buffer.length === 5_760_000, "the photo is no longer served");
  });

  await check("the local put stand-in is not a door on a Supabase deployment", async () => {
    const { status, json } = await call(`/api/cms/photos?action=put&token=${"0".repeat(48)}`, { method: "PUT" });
    assert(status === 400, `the stand-in route answered ${status} ${JSON.stringify(json)}`);
    assert(/স্থানীয়/.test(String(json?.message)), JSON.stringify(json));
  });

  await check("a storage that cannot sign falls back instead of failing the upload", async () => {
    storage.settings.breakSign = true;
    try {
      const { status, json } = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "fallback.png", size: 5_760_000 } });
      assert(status === 200, `an unsigned begin answered ${status} ${JSON.stringify(json)}`);
      assert(json.supported === false, `the answer promised a grant anyway: ${JSON.stringify(json)}`);
      assert(typeof json.reason === "string" && json.reason.length > 0, "no reason was given for the fallback");
      assert(status !== 502 && status !== 503, `the teacher would have seen ${status} for a storage outage`);
      assert(stagingKeys().length === 0, "a failed sign still left a staging object");
    } finally {
      storage.settings.breakSign = false;
    }
  });

  console.log("\n— what the bucket itself can refuse —");

  await check("a bucket size limit refuses the photo at storage, after our API said yes", async () => {
    /* Supabase reads file_size_limit off the bucket row inside uploadFromRequest(), which
     * the signed-upload route calls too — so a bucket can say no to a file this app
     * accepted. Nothing here can read that setting, so the behaviour that matters is that
     * the refusal is storage's, nothing is registered, and the grant is not burned. */
    storage.settings.fileSizeLimit = 4_000_000;
    try {
      const begin = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "over-bucket.png", size: 5_760_000 } });
      assert(begin.status === 201, `our API refused before storage got a chance: ${JSON.stringify(begin.json)}`);
      const put = await putToBucket(begin.json, await photoOf(5_760_000));
      assert(put.status === 413, `storage answered ${put.status}`);
      const body = await put.text();
      assert(/EntityTooLarge/.test(body), `not the refusal Supabase sends: ${body}`);
      assert(!storage.objects.has(begin.json.staging_key), "a refused write still landed in the bucket");
      const recorded = storage.find((entry) => entry.path.endsWith(begin.json.staging_key) && entry.method === "PUT")[0];
      assert(recorded.bytes === 5_760_000, `storage saw ${recorded.bytes} bytes`);
      const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: "over-bucket.png" } });
      assert(commit.status === 404, `a photo was registered for bytes storage refused (${commit.status})`);
      // The refused PUT must not consume the grant: with the limit lifted the same
      // upload completes, which is what a retry after raising the limit depends on.
      storage.settings.fileSizeLimit = 0;
      const retry = await putToBucket(begin.json, await photoOf(5_760_000));
      assert(retry.status === 200, `the same grant was unusable after the limit was lifted (${retry.status})`);
      const done = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: "over-bucket.png" } });
      assert(done.status === 201, `the retry did not complete (${done.status} ${JSON.stringify(done.json)})`);
      committed += 1;
    } finally {
      storage.settings.fileSizeLimit = 0;
    }
  });

  await check("a bucket that lists allowed MIME types refuses one it does not name", async () => {
    storage.settings.allowedMimeTypes = ["image/jpeg"];
    try {
      const begin = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "png-when-only-jpeg.png", size: 200_000 } });
      assert(begin.status === 201, JSON.stringify(begin.json));
      const put = await putToBucket(begin.json, await photoOf(200_000));
      assert(put.status === 400, `the bucket did not refuse the type (${put.status})`);
      assert(/InvalidMimeType/.test(await put.text()), "the refusal was not Supabase's MIME error");
      const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: "png-when-only-jpeg.png" } });
      assert(commit.status === 404, `a photo was registered for bytes the bucket refused (${commit.status})`);
      const aborted = await call("/api/cms/photos?action=abort", { method: "POST", body: { staging_key: begin.json.staging_key } });
      assert(aborted.json.removed === true, "the staging key could not be handed back after a bucket refusal");
    } finally {
      storage.settings.allowedMimeTypes = [];
    }
  });

  console.log("\n— what the driver accepts from storage —");

  for (const shape of ["relative", "pathless"]) {
    await check(`a ${shape} sign answer is still turned into a usable upload URL`, async () => {
      storage.settings.signShape = shape;
      try {
        const begin = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: `${shape}.png`, size: 2048 } });
        assert(begin.status === 201, JSON.stringify(begin.json));
        const url = new URL(begin.json.upload_url);
        assert(url.origin === `http://127.0.0.1:${storagePort}`, `the URL left storage: ${begin.json.upload_url}`);
        assert(url.pathname === `/storage/v1/object/upload/sign/${BUCKET}/${begin.json.staging_key}`, `odd pathname: ${url.pathname}`);
        assert(url.searchParams.get("token"), `no token survived: ${begin.json.upload_url}`);
        const put = await putToBucket(begin.json, await photoOf(2048));
        assert(put.status === 200, `the normalised URL did not accept the file (${put.status})`);
        const commit = await call("/api/cms/photos?action=commit", { method: "POST", body: { album_id: albumId, staging_key: begin.json.staging_key, name: `${shape}.png` } });
        assert(commit.status === 201, `the ${shape} shape could not complete an upload (${commit.status})`);
        committed += 1;
      } finally {
        storage.settings.signShape = "absolute";
      }
    });
  }

  await check("a stale staging object is swept and a live one is left alone", async () => {
    const label = new Date().toISOString().slice(0, 7);
    const stale = `images/incoming/${label}/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa`;
    const live = `images/incoming/${label}/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb`;
    const outside = `images/${label}/cccccccc-3333-4333-8333-cccccccccccc.png`;
    storage.seed(stale, "abandoned", { ageHours: 9 });
    storage.seed(live, "someone is mid-upload");
    storage.seed(outside, "a real photo");
    const { status } = await call("/api/cms/photos?action=begin", { method: "POST", body: { name: "sweep-me.png", size: 1024 } });
    assert(status === 201, `begin → ${status}`);
    assert(!storage.objects.has(stale), "a 9-hour-old staging object survived the sweep");
    assert(storage.objects.has(live), "a staging object still inside its window was deleted");
    assert(storage.objects.has(outside), "the sweep reached outside images/incoming — it may only ever clear staging");
    for (const key of [live, outside]) storage.objects.delete(key);
  });

  await check("only registered photos are left in the bucket — nothing was orphaned", async () => {
    const left = [...storage.objects.keys()];
    const stray = left.filter((key) => STAGING_KEY.test(key));
    assert(stray.length === 0, `staging objects left behind: ${JSON.stringify(stray)}`);
    const unexpected = left.filter((key) => !MEDIA_KEY.test(key));
    assert(unexpected.length === 0, `unexpected keys in the bucket: ${JSON.stringify(unexpected)}`);
    assert(left.length === committed, `${committed} photo(s) were committed but the bucket holds ${left.length}: ${JSON.stringify(left)}`);
    return `${left.length} object(s) in the fake bucket, all of them registered photos`;
  });
} catch (error) {
  record("unexpected harness failure", false, error?.stack || String(error));
} finally {
  await storage.close();
  app.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
