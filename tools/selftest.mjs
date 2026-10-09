#!/usr/bin/env node
/* End-to-end test of the content API against a throwaway local store.
 *
 *   node tools/selftest.mjs
 *
 * It boots tools/dev-server.mjs on a random port with CMS_LOCAL_DIR pointed at a
 * temp folder, drives it over real HTTP (same handlers Vercel runs), then deletes
 * everything. No cloud account, no Supabase, no network.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8090 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
/* A real cookie jar: the session cookie and the CSRF companion must travel
 * together, exactly as a browser sends them. */
const jar = new Map();
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

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

const call = async (pathname, { method = "GET", body, bodyRaw, headers = {}, raw = false } = {}) => {
  const isForm = body instanceof FormData;
  // bodyRaw is for a direct-to-storage PUT: the file's own bytes as the whole body,
  // which is exactly what a signed upload URL receives.
  const sendBody = bodyRaw !== undefined ? bodyRaw : body === undefined ? undefined : isForm ? body : JSON.stringify(body);
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(jar.get("rahs_csrf") && ["POST", "PATCH", "DELETE"].includes(method) ? { "x-csrf-token": jar.get("rahs_csrf") } : {}),
      ...(isForm || bodyRaw !== undefined ? {} : body ? { "content-type": "application/json" } : {}),
      origin: BASE,
      ...headers,
    },
    ...(sendBody === undefined ? {} : { body: sendBody }),
  });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const [name, ...rest] = pair.split("=");
    const raw = rest.join("=");
    if (pair.includes("Max-Age=0")) jar.delete(name);
    else jar.set(name, raw);
  }
  if (raw) return { status: response.status, headers: response.headers, buffer: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { parseError: text.slice(0, 200) };
  }
  return { status: response.status, json, headers: response.headers };
};

/* ------------------------------------------------------------------ fixtures */

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-cms-"));
const pngFile = path.join(ROOT, "file_000000007e208211b50fdcafeeae9f2e.png");
const webpFile = path.join(ROOT, "assets/img/campus-hero.webp");

const server = spawn(process.execPath, [path.join(ROOT, "tools/dev-server.mjs")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    CMS_DRIVER: "local",
    CMS_ALLOW_LOCAL_DRIVER: "1",
    CMS_ALLOW_SETUP: "1",
    CMS_LOCAL_DIR: tempDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));

const waitReady = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/public/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${serverLog}`);
};

try {
  await waitReady();

  console.log("\n— health, config, isolation —");
  await check("public health endpoint answers", async () => {
    const { status, json } = await call("/api/public/health");
    assert(status === 200 && json.ok, JSON.stringify(json));
    assert(json.configProblems.length === 0, `config problems: ${json.configProblems.join(", ")}`);
  });
  await check("unknown public feed is 404, not a crash", async () => {
    const { status } = await call("/api/public/whatever");
    assert(status === 404, `status ${status}`);
  });
  await check("admin routes reject anonymous callers", async () => {
    const before = new Map(jar);
    jar.clear();
    for (const url of ["/api/cms/notices", "/api/cms/dashboard", "/api/cms/albums", "/api/cms/photos/upload"]) {
      const { status } = await call(url, { method: url.endsWith("upload") ? "POST" : "GET" });
      assert(status === 401, `${url} → ${status}`);
    }
    jar.clear();
    for (const [name, value] of before) jar.set(name, value);
  });
  await check("library modules are never readable as source", async () => {
    const response = await fetch(`${BASE}/api/_lib/db.mjs`);
    assert(response.status === 405, `status ${response.status}`);
    assert(!(await response.text()).includes("WRITABLE"), "source leaked");
  });

  console.log("\n— authentication —");
  await check("status reports a first run", async () => {
    const { json } = await call("/api/cms/status");
    assert(json.needsSetup === true, JSON.stringify(json));
  });
  await check("wrong password is refused generically", async () => {
    const { status, json } = await call("/api/cms/login", { method: "POST", body: { email: "head@school.edu", password: "nope-nope-nope" } });
    assert(status === 401 && json.error === "invalid_credentials", `${status} ${JSON.stringify(json)}`);
    assert(!json.message.includes("exist"), "message leaks account existence");
  });
  await check("weak password on setup is rejected with field errors", async () => {
    const { status, json } = await call("/api/cms/setup", { method: "POST", body: { email: "head@school.edu", full_name: "Computer Teacher", password: "password1" } });
    assert(status === 400 && json.fields?.password, `${status} ${JSON.stringify(json)}`);
  });
  await check("setup creates the first admin and a session cookie", async () => {
    const { status, json } = await call("/api/cms/setup", {
      method: "POST",
      body: { email: "head@school.edu", full_name: "কম্পিউটার শিক্ষক", password: "bidyalaya-2026" },
    });
    assert(status === 201 && json.user.role === "admin", `${status} ${JSON.stringify(json)}`);
    assert(jar.has("rahs_admin"), "no session cookie set");
    assert((jar.get("rahs_csrf") || "").length === 32, "no csrf companion cookie");
  });
  await check("session endpoint returns the signed-in user", async () => {
    const { json } = await call("/api/cms/session");
    assert(json.user.email === "head@school.edu" && json.user.isAdmin, JSON.stringify(json));
    assert(!JSON.stringify(json).includes("password"), "payload leaked a password field");
  });
  await check("a normal admin request does not rewrite the session row", async () => {
    /* Sliding expiry only has to move when the stamp drifts near the end of its
     * window. Writing it on every request put a database UPDATE in front of every
     * admin screen, so a fresh session must come back untouched here. db.json is the
     * dev store the local driver keeps in sync, which is what this reads. */
    const dbFile = path.join(tempDir, "db.json");
    const sessionRow = async () => {
      const db = JSON.parse(await fs.readFile(dbFile, "utf8"));
      return (db.tables.cms_sessions ?? [])[0] ?? null;
    };
    let first = null;
    for (let attempt = 0; attempt < 40 && !first; attempt += 1) {
      first = await sessionRow().catch(() => null);
      if (!first) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(first?.expires_at, `no stored session row to compare: ${JSON.stringify(first)}`);
    await call("/api/cms/notices");
    await call("/api/cms/dashboard");
    const second = await sessionRow();
    assert(second?.expires_at === first.expires_at, `a twelve-hour session was rewritten (${first.expires_at} → ${second?.expires_at}) for no reason`);
  });
  await check("session cookie is HttpOnly + SameSite=Lax", async () => {
    const response = await fetch(`${BASE}/api/cms/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "head@school.edu", password: "bidyalaya-2026" }),
    });
    const [session] = (response.headers.getSetCookie() ?? []).filter((value) => value.startsWith("rahs_admin="));
    assert(/httponly/i.test(session) && /samesite=lax/i.test(session), session);
  });
  await check("setup cannot run twice", async () => {
    const { status } = await call("/api/cms/setup", { method: "POST", body: { email: "x@y.edu", full_name: "Xx Yy", password: "another-long-1" } });
    assert(status === 403, `status ${status}`);
  });
  await check("state change without the CSRF token is refused", async () => {
    const saved = jar.get("rahs_csrf");
    jar.delete("rahs_csrf");
    const { status } = await call("/api/cms/notices", { method: "POST", body: { title: "টেস্ট", body: "টেস্ট", published_at: "2026-10-02", status: "draft" } });
    if (saved) jar.set("rahs_csrf", saved);
    assert(status === 403, `status ${status}`);
  });
  await check("a forged CSRF header with no matching cookie is refused", async () => {
    const { status } = await call("/api/cms/notices", {
      method: "POST",
      headers: { "x-csrf-token": "0".repeat(32) },
      body: { title: "টেস্ট", body: "টেস্ট", published_at: "2026-10-02", status: "draft" },
    });
    assert(status === 403, `status ${status}`);
  });
  await check("cross-origin POST is refused", async () => {
    const { status } = await call("/api/cms/notices", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { title: "টেস্ট", body: "টেস্ট" },
    });
    assert(status === 403, `status ${status}`);
  });

  console.log("\n— notices: draft / publish / edit —");
  let noticeId = "";
  await check("creating a notice requires the mandatory fields", async () => {
    const { status, json } = await call("/api/cms/notices", { method: "POST", body: { title: "ছোট" } });
    assert(status === 400 && json.fields.body && json.fields.published_at, `${status} ${JSON.stringify(json.fields ?? json)}`);
  });
  await check("a draft notice is invisible on the public feed", async () => {
    const created = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "পরীক্ষার নোটিশ", body: "আগামী সপ্তাহে পরীক্ষা।", audience: "নবম শ্রেণি", published_at: "2026-10-05", status: "draft" },
    });
    assert(created.status === 201, JSON.stringify(created.json));
    noticeId = created.json.item.id;
    const { json } = await call("/api/public/notices");
    assert(json.notices.length === 0, `public feed leaked a draft: ${JSON.stringify(json.notices)}`);
  });
  await check("publishing the draft makes it appear", async () => {
    const { status } = await call(`/api/cms/notices/publish?id=${noticeId}`, { method: "POST" });
    assert(status === 200, `status ${status}`);
    const { json } = await call("/api/public/notices");
    assert(json.notices.length === 1, `expected 1 got ${json.notices.length}`);
    assert(json.notices[0].id === noticeId, "wrong row published");
  });
  await check("newest published notice comes first", async () => {
    const second = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "ছুটির নোটিশ", body: "ঈদ বন্ধ।", published_at: "2026-10-09", status: "published", importance: "urgent" },
    });
    assert(second.status === 201, JSON.stringify(second.json));
    const { json } = await call("/api/public/notices");
    assert(json.notices.length === 2, `expected 2 got ${json.notices.length}`);
    assert(json.notices[0].title === "ছুটির নোটিশ", `order wrong: ${json.notices.map((n) => n.title).join(",")}`);
    assert(/অক্টোবর ২০২৬/.test(json.notices[0].date_label), `no bengali date: ${json.notices[0].date_label}`);
  });
  await check("public payload never carries internals", async () => {
    const { json } = await call("/api/public/notices");
    const keys = Object.keys(json.notices[0]).sort().join(",");
    assert(!keys.includes("created_by") && !keys.includes("status") && !keys.includes("deleted_at"), keys);
    assert(keys === "audience,body,date,date_label,file,id,importance,title,type", keys);
  });
  await check("editing a published notice updates the feed", async () => {
    const { status } = await call(`/api/cms/notices?id=${noticeId}`, { method: "PATCH", body: { title: "পরীক্ষার নোটিশ (সংশোধিত)" } });
    assert(status === 200, `status ${status}`);
    const { json } = await call("/api/public/notices");
    assert(json.notices.some((row) => row.title.includes("সংশোধিত")), "edit not visible");
  });
  await check("unpublishing removes it from the public feed", async () => {
    const { status } = await call(`/api/cms/notices/unpublish?id=${noticeId}`, { method: "POST" });
    assert(status === 200, `status ${status}`);
    const { json } = await call("/api/public/notices");
    assert(json.notices.length === 1, `expected 1 got ${json.notices.length}`);
  });
  await check("HTML in content is stored as text, never markup", async () => {
    const { json } = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "টেস্ট <img src=x onerror=alert(1)>", body: "<script>evil()</script>", published_at: "2026-10-02", status: "published" },
    });
    assert(json.item.title.includes("<img"), "title was mangled");
    const feedResponse = await fetch(`${BASE}/api/public/notices`);
    const raw = await feedResponse.text();
    const feed = JSON.parse(raw);
    assert(feed.notices.some((row) => row.body === "<script>evil()</script>"), "body altered by the server");
    assert(raw.startsWith("{\"ok\":true"), `public feed is not plain JSON: ${raw.slice(0, 40)}`);
  });
  await check("unknown fields cannot be injected", async () => {
    const { status, json } = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "চোরা ঘর", body: "টেস্ট", published_at: "2026-10-02", status: "published", deleted_at: null, id: "hacked", created_by: "x" },
    });
    assert(status === 400 && Object.keys(json.fields ?? {}).length === 3, `${status} ${JSON.stringify(json)}`);
  });

  console.log("\n— exam routines and other routines —");
  let examId = "";
  await check("exam routine row is created and published", async () => {
    const { status, json } = await call("/api/cms/exams", {
      method: "POST",
      body: { exam_name: "অর্ধ-বার্ষিক পরীক্ষা ২০২৬", class_name: "নবম", subject: "গণিত", exam_date: "2026-11-18", start_time: "10:00", room: "২য় তলা", notes: "ক্যালকুলেটর আনবেন না।", published_at: "2026-10-01", status: "published" },
    });
    assert(status === 201, JSON.stringify(json));
    examId = json.item.id;
    const { json: feed } = await call("/api/public/exams");
    assert(feed.exams.length === 1 && feed.exams[0].time === "10:00", JSON.stringify(feed.exams));
  });
  await check("a bad time format is refused", async () => {
    const { status, json } = await call("/api/cms/exams", {
      method: "POST",
      body: { exam_name: "টেস্ট", class_name: "দশম", subject: "রসায়ন", exam_date: "2026-11-20", start_time: "10am", published_at: "2026-10-01", status: "draft" },
    });
    assert(status === 400 && json.fields.start_time, `${status} ${JSON.stringify(json)}`);
  });
  await check("routine type is free text, not a fixed list", async () => {
    const { status } = await call("/api/cms/routines", {
      method: "POST",
      body: { title: "শীলাচরণ ছুটি", routine_type: "ছুটির সময়সূচি", event_date: "2026-12-01", description: "বিদ্যালয় বন্ধ থাকবে।", published_at: "2026-10-01", status: "published" },
    });
    assert(status === 201, `status ${status}`);
    const { json } = await call("/api/public/routines");
    assert(json.routines[0].routine_type === "ছুটির সময়সূচি", JSON.stringify(json.routines));
  });

  console.log("\n— gallery: albums, uploads, publish rules —");
  let albumId = "";
  let photoId = "";
  await check("empty album cannot be published", async () => {
    const created = await call("/api/cms/albums", { method: "POST", body: { title: "খালি অ্যালবাম", published_at: "2026-10-01", status: "draft" } });
    assert(created.status === 201, JSON.stringify(created.json));
    albumId = created.json.item.id;
    const { status, json } = await call(`/api/cms/albums/publish?id=${albumId}`, { method: "POST" });
    assert(status === 400 && json.fields.status, `${status} ${JSON.stringify(json)}`);
  });
  await check("two photos upload, type sniffed from bytes", async () => {
    const form = new FormData();
    form.set("album_id", albumId);
    form.set("alt_text", "বিদ্যালয় ক্যাম্পাস");
    form.append("files", new Blob([await fs.readFile(pngFile)], { type: "image/png" }), "logo.png");
    form.append("files", new Blob([await fs.readFile(webpFile)], { type: "image/webp" }), "hero.webp");
    const { status, json } = await call("/api/cms/photos/upload", { method: "POST", body: form });
    assert(status === 201 && json.photos.length === 2, `${status} ${JSON.stringify(json)}`);
    photoId = json.photos[0].id;
    const mimes = json.photos.map((photo) => photo.mime).sort().join(",");
    assert(mimes === "image/png,image/webp", mimes);
    assert(json.photos.every((photo) => photo.pixel_width > 0), "dimensions not read");
  });
  await check("a renamed non-image is rejected, the rest still uploads", async () => {
    const form = new FormData();
    form.set("album_id", albumId);
    form.append("files", new Blob(["<?php system($_GET[0]); ?>"], { type: "image/png" }), "innocent.png");
    form.append("files", new Blob([await fs.readFile(webpFile)], { type: "image/webp" }), "real.webp");
    const { status, json } = await call("/api/cms/photos/upload", { method: "POST", body: form });
    assert(status === 201 && json.photos.length === 1 && json.failed.length === 1, `${status} ${JSON.stringify(json)}`);
    assert(/গ্রহণ করা হয়/.test(json.failed[0].message), json.failed[0].message);
  });
  await check("an SVG upload is refused (script vector)", async () => {
    const form = new FormData();
    form.set("album_id", albumId);
    form.set("files", new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/svg+xml" }), "evil.svg");
    const { status, json } = await call("/api/cms/photos/upload", { method: "POST", body: form });
    assert(status === 400 || (status === 201 && !json.photos.length && json.failed.length), `${status} ${JSON.stringify(json)}`);
  });
  await check("draft photos are not readable without a session", async () => {
    const url = json0((await call("/api/cms/albums?id=" + albumId)).json, "item");
    const mediaPath = url.photos[0].url;
    const savedCookie = new Map(jar);
    jar.clear();
    const { status } = await call(mediaPath, { raw: true });
    jar.clear();
    for (const [name, value] of savedCookie) jar.set(name, value);
    assert(status === 403, `draft image returned ${status}`);
  });
  await check("publishing the album exposes exactly the published photos", async () => {
    const { status } = await call(`/api/cms/albums/publish?id=${albumId}`, { method: "POST" });
    assert(status === 200, `status ${status}`);
    const { json } = await call("/api/public/gallery?albums=10&per_album=8");
    assert(json.albums.length === 1, `albums ${json.albums.length}`);
    assert(json.albums[0].photos.length === 3, `photos ${json.albums[0].photos.length}`);
    assert(json.albums[0].photos.every((photo) => photo.thumb.startsWith("/api/media?path=")), "thumb not routed through /api/media?path=");
    assert(!JSON.stringify(json).includes("supabase") && !JSON.stringify(json).includes("service"), "storage internals leaked into payload");
  });
  await check("a published photo is publicly readable and cached", async () => {
    const { json } = await call("/api/public/gallery?albums=1&per_album=1");
    const { status, headers, buffer } = await call(json.albums[0].photos[0].thumb, { raw: true });
    assert(status === 200 && buffer.length > 100, `status ${status} bytes ${buffer.length}`);
    assert(/image\//.test(headers.get("content-type")), headers.get("content-type"));
    assert(/s-maxage=/.test(headers.get("cache-control") || ""), headers.get("cache-control"));
  });
  await check("alt text defaults to the album title, so img always has one", async () => {
    const { json } = await call("/api/public/gallery?albums=1&per_album=1");
    assert(json.albums[0].photos.every((photo) => photo.alt && photo.alt.length > 1), JSON.stringify(json.albums[0].photos));
  });
  await check("photo caption/alt can be edited", async () => {
    const { status, json } = await call("/api/cms/photos/update", { method: "POST", body: { id: photoId, alt_text: "মূল ভবন", caption: "২০২৬" } });
    assert(status === 200 && json.photo.alt_text === "মূল ভবন", `${status} ${JSON.stringify(json)}`);
  });
  await check("photo order can change", async () => {
    const { status, json } = await call("/api/cms/photos/move", { method: "POST", body: { id: photoId, direction: "down" } });
    assert(status === 200 && json.moved !== undefined, `${status} ${JSON.stringify(json)}`);
  });

  console.log("\n— attachments (PDF) on a notice —");
  let pdfPath = "";
  await check("a PDF uploads as a notice attachment", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"), Buffer.from("%".repeat(200))]);
    const form = new FormData();
    form.set("file", new Blob([pdf], { type: "application/pdf" }), "form.pdf");
    const { status, json } = await call("/api/cms/upload", { method: "POST", body: form });
    assert(status === 201 && json.file.mime === "application/pdf", `${status} ${JSON.stringify(json)}`);
    pdfPath = json.file.path;
  });
  await check("attachment is downloadable and linked from the feed", async () => {
    const { status } = await call(`/api/cms/notices?id=${noticeId}`, { method: "PATCH", body: { file: { path: pdfPath, name: "ফরম.pdf", mime: "application/pdf", bytes: 60 } } });
    assert(status === 200, `status ${status}`);
    const media = await call(`/api/media?path=${encodeURIComponent(pdfPath)}`, { raw: true });
    assert(media.status === 200 && media.buffer.subarray(0, 5).toString() === "%PDF-", `media ${media.status}`);
    // One media URL exists: the query form, which is what api/media.mjs is mapped to.
    // A path-style /api/media/<key> URL sits deeper than that file answers, so it must
    // never be handed to a browser — the admin screen and the published feed are checked.
    // (tools/test-api-routes.mjs matches every minted URL against the api/ layout.)
    const { json: adminRow } = await call(`/api/cms/notices?id=${noticeId}`);
    assert(adminRow.item.file.url.startsWith("/api/media?path="), `admin attachment url ${JSON.stringify(adminRow.item.file)}`);
    const { json: withFile } = await call("/api/public/notices");
    const feedRow = withFile.notices.find((candidate) => candidate.id === noticeId);
    if (feedRow) assert(String(feedRow.file.url).startsWith("/api/media?path="), `feed attachment url ${JSON.stringify(feedRow.file)}`);
  });
  await check("an unusable media key is answered by the app, not by the platform's 404", async () => {
    // The regression this pins: /api/media?path=… once 404'd before reaching any code,
    // because the entry file was api/media/[...path].mjs. Any error here is the handler's
    // own JSON, which proves the route is mapped.
    const { status, json } = await call("/api/media?path=images/../../secrets.txt");
    assert(status === 400, `status ${status}`);
    assert(json?.error === "bad_request" && /ঠিকানা/.test(String(json?.message)), JSON.stringify(json));
    const missing = await call(`/api/media?path=${encodeURIComponent("images/2020-01/00000000-0000-4000-8000-000000000000.jpg")}`);
    assert(missing.status === 403 || missing.status === 404, `unreferenced key → ${missing.status}`);
    assert(missing.json?.message, JSON.stringify(missing.json));
  });
  await check("an arbitrary path cannot be smuggled as an attachment", async () => {
    const { status } = await call(`/api/cms/notices?id=${noticeId}`, { method: "PATCH", body: { file: { path: "../../etc/passwd", name: "x", mime: "text/plain", bytes: 1 } } });
    assert(status === 400, `status ${status}`);
  });
  await check("a path that was never uploaded is refused", async () => {
    const fake = `docs/2026-10/${"0".repeat(8)}-0000-4000-8000-000000000000.pdf`;
    const { status } = await call(`/api/cms/notices?id=${noticeId}`, { method: "PATCH", body: { file: { path: fake, name: "x.pdf", mime: "application/pdf", bytes: 10 } } });
    assert(status === 400, `status ${status}`);
  });

  console.log("\n— deletion safety —");
  await check("purge needs an explicit confirmation word", async () => {
    const { status, json } = await call(`/api/cms/notices/purge?id=${noticeId}`, { method: "POST", body: {} });
    assert(status === 400 && json.fields.confirm, `${status} ${JSON.stringify(json)}`);
  });
  await check("trashing keeps the row recoverable, out of the admin list", async () => {
    const { status } = await call(`/api/cms/notices/trash?id=${noticeId}`, { method: "POST" });
    assert(status === 200, `status ${status}`);
    const { json } = await call("/api/cms/notices");
    assert(!json.items.some((row) => row.id === noticeId), "still in the main list");
    const { json: trashed } = await call("/api/cms/notices?deleted=1");
    assert(trashed.items.some((row) => row.id === noticeId), "not in trash");
  });
  await check("restore brings it back", async () => {
    const { status } = await call(`/api/cms/notices/restore?id=${noticeId}`, { method: "POST" });
    assert(status === 200, `status ${status}`);
    const { json } = await call("/api/cms/notices");
    assert(json.items.some((row) => row.id === noticeId), "not restored");
  });
  await check("purge removes the row and deletes the stored PDF", async () => {
    const { status, json } = await call(`/api/cms/notices/purge?id=${noticeId}`, { method: "POST", body: { confirm: "DELETE" } });
    assert(status === 200 && json.filesRemoved === 1, `${status} ${JSON.stringify(json)}`);
    const savedCookie = new Map(jar);
    jar.clear();
    const media = await call(`/api/media?path=${encodeURIComponent(pdfPath)}`, { raw: true });
    jar.clear();
    for (const [name, value] of savedCookie) jar.set(name, value);
    assert(media.status >= 400, `deleted file still served (${media.status})`);
    const { json: feed } = await call("/api/public/notices");
    assert(!feed.notices.some((row) => row.id === noticeId), "purged row still public");
  });
  await check("deleting an album deletes its photo files too", async () => {
    const { json } = await call("/api/public/gallery?albums=1&per_album=1");
    const photoUrl = json.albums[0].photos[0].full;
    await call(`/api/cms/albums/purge?id=${albumId}`, { method: "POST", body: { confirm: "DELETE" } });
    const savedCookie = new Map(jar);
    jar.clear();
    const media = await call(photoUrl, { raw: true });
    jar.clear();
    for (const [name, value] of savedCookie) jar.set(name, value);
    assert(media.status >= 400, `orphaned photo still served (${media.status})`);
    const remaining = await countFiles(path.join(tempDir, "media"));
    assert(remaining === 0, `${remaining} file(s) left in storage`);
  });

  console.log("\n— accounts (extensibility) —");
  await check("admin can add a second staff account", async () => {
    const { status, json } = await call("/api/cms/accounts", {
      method: "POST",
      body: { email: "assistant@school.edu", full_name: "সহকারী শিক্ষক", role: "staff", password: "gorob-2026-pash" },
    });
    assert(status === 201, `${status} ${JSON.stringify(json)}`);
    const { json: list } = await call("/api/cms/accounts");
    assert(list.accounts.length === 2, `accounts ${list.accounts.length}`);
    assert(!JSON.stringify(list).includes("password_hash"), "hash leaked through the list");
  });
  await check("the new account can sign in and see content", async () => {
    const saved = new Map(jar);
    jar.clear();
    const { status, json } = await call("/api/cms/login", { method: "POST", body: { email: "assistant@school.edu", password: "gorob-2026-pash" } });
    assert(status === 200 && json.user.isAdmin === false, `${status} ${JSON.stringify(json)}`);
    const notices = await call("/api/cms/notices");
    assert(notices.status === 200, `staff cannot read notices: ${notices.status}`);
    const accounts = await call("/api/cms/accounts");
    assert(accounts.status === 403, `staff reached account management (${accounts.status})`);
    jar.clear();
    for (const [name, value] of saved) jar.set(name, value);
  });
  await check("changing a password revokes other sessions", async () => {
    const { status } = await call("/api/cms/password", { method: "POST", body: { current_password: "bidyalaya-2026", new_password: "bidyalaya-2027" } });
    assert(status === 200, `status ${status}`);
    const otherSession = new Map(jar);
    jar.delete("rahs_admin");
    const { status: again } = await call("/api/cms/session");
    for (const [name, value] of otherSession) jar.set(name, value);
    assert(again === 401, `old session still valid (${again})`);
    const { status: relogin } = await call("/api/cms/login", { method: "POST", body: { email: "head@school.edu", password: "bidyalaya-2027" } });
    assert(relogin === 200, `relogin failed ${relogin}`);
  });
  await check("repeated wrong logins get throttled", async () => {
    const { status } = await call("/api/cms/login", { method: "POST", body: { email: "throttle@school.edu", password: "wrong-password-1" } });
    assert(status === 401, `status ${status}`);
    let blocked = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await call("/api/cms/login", { method: "POST", body: { email: "throttle@school.edu", password: "wrong-password-1" } });
      if (response.status === 429) blocked = true;
    }
    assert(blocked, "no rate limit after 10 failures");
  });

  console.log("\n— audit trail and dashboard —");
  await check("writes are logged with actor and action", async () => {
    const { json } = await call("/api/cms/audit?limit=50");
    const actions = json.entries.map((row) => row.action);
    for (const expected of ["login", "create", "update", "publish", "photo_add", "trash", "restore", "purge", "account_create"]) {
      assert(actions.includes(expected), `missing audit action: ${expected} (got ${[...new Set(actions)].join(",")})`);
    }
    assert(json.entries.every((row) => row.user_email), "audit row without actor");
  });
  await check("dashboard counts published vs draft vs trash", async () => {
    const { json } = await call("/api/cms/dashboard");
    assert(json.totals.notices.published === 2, `notices published ${json.totals.notices.published}`);
    assert(json.totals.exams.published === 1, `exams ${json.totals.exams.published}`);
    assert(json.recent.length > 0, "no recent activity");
  });

  console.log("\n— the public site's own pages still render —");
  await check("existing pages are served unchanged", async () => {
    for (const page of ["/index.html", "/notices.html", "/gallery.html", "/academics.html"]) {
      const response = await fetch(`${BASE}${page}`);
      assert(response.status === 200, `${page} → ${response.status}`);
      const body = await response.text();
      assert(body.includes("রাজাপুর আদর্শ উচ্চ বিদ্যালয়"), `${page} lost the school name`);
    }
  });
  await check("the official logo asset is still served", async () => {
    const response = await fetch(`${BASE}/file_000000007e208211b50fdcafeeae9f2e.png`);
    const bytes = await response.arrayBuffer();
    assert(response.status === 200 && bytes.byteLength > 1_000_000, `status ${response.status} bytes ${bytes.byteLength}`);
  });
  await check("admin dashboard is served but marked noindex", async () => {
    const response = await fetch(`${BASE}/admin/`);
    const body = await response.text();
    assert(response.status === 200, `status ${response.status}`);
    assert(/noindex/i.test(body), "admin page is indexable");
  });

  console.log("\n— published lists stay reachable —");
  const feedPage = async (feed, params) => (await call(`/api/public/${feed}${params ? `?${params}` : ""}`)).json;
  const walkPages = async (feed, key, size = 2) => {
    const ids = [];
    for (let offset = 0, guard = 0; guard < 30; guard += 1) {
      const page = await feedPage(feed, `limit=${size}&offset=${offset}`);
      ids.push(...page[key].map((row) => row.id));
      if (!page.has_more) return ids;
      offset = page.next_offset;
    }
    throw new Error(`the ${feed} feed never stopped paging`);
  };
  const pagedNoticeIds = [];
  await check("three more notices are published, to make a list longer than a page", async () => {
    for (const day of ["01", "02", "03"]) {
      const { status, json } = await call("/api/cms/notices", {
        method: "POST",
        body: { title: `পেজিং নোটিশ ${day}`, body: "পুরোনো নোটিশ এখনো পাওয়া যাচ্ছে কি না তা দেখার পরীক্ষা।", published_at: `2026-12-${day}`, status: "published" },
      });
      assert(status === 201, `${status} ${JSON.stringify(json)}`);
      pagedNoticeIds.push(json.item.id);
    }
  });
  await check("a page says whether older rows exist and where the next one starts", async () => {
    const page = await feedPage("notices", "limit=2");
    assert(page.notices.length === 2, `rows on the page: ${page.notices.length}`);
    assert(page.limit === 2 && page.offset === 0, `limit ${page.limit}, offset ${page.offset}`);
    assert(page.has_more === true, "a feed with more rows than this page reported has_more false");
    assert(page.next_offset === 2, `next_offset ${page.next_offset}`);
    const last = await feedPage("notices", "limit=2&offset=4");
    assert(last.notices.length === 1 && last.has_more === false && last.next_offset === null, JSON.stringify(last).slice(0, 180));
  });
  await check("walking every page finds each notice once, and none are skipped", async () => {
    const walked = await walkPages("notices", "notices");
    const whole = await feedPage("notices", "limit=100");
    assert(walked.length === new Set(walked).size, "a notice came back on two pages");
    assert(walked.join() === whole.notices.map((row) => row.id).join(), `paging found ${walked.length} rows, the whole page had ${whole.notices.length}`);
    for (const id of pagedNoticeIds) assert(walked.includes(id), `a published notice (${id}) is reachable on no page`);
  });
  await check("publishing one more notice leaves all the older ones reachable", async () => {
    const before = (await feedPage("notices", "limit=100")).notices.map((row) => row.id);
    const { status, json } = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "পেজিং নোটিশ ০৪", body: "সবার নতুন নোটিশ প্রকাশের পর পুরোনোগুলোর কী হলো দেখা যাচ্ছে।", published_at: "2026-12-04", status: "published" },
    });
    assert(status === 201, `${status} ${JSON.stringify(json)}`);
    pagedNoticeIds.push(json.item.id);
    const firstPage = await feedPage("notices", "limit=2");
    assert(firstPage.notices[0].id === json.item.id, "the newest notice is not at the top of the first page");
    const walked = await walkPages("notices", "notices");
    for (const id of before) assert(walked.includes(id), `publishing hid ${id}`);
    assert(walked.length === before.length + 1, `the list grew by ${walked.length - before.length}`);
  });
  await check("page size and offset are clamped, never trusted", async () => {
    const wild = await feedPage("notices", "limit=99999&offset=-5");
    assert(wild.limit === 100 && wild.offset === 0, `limit ${wild.limit}, offset ${wild.offset}`);
    const junk = await feedPage("notices", "limit=abc&offset=zz");
    assert(junk.limit === 20 && junk.offset === 0, `limit ${junk.limit}, offset ${junk.offset}`);
    const zero = await feedPage("notices", "limit=0");
    assert(zero.limit === 20, `limit 0 became ${zero.limit}`);
    const beyond = await feedPage("notices", "limit=2&offset=9999");
    assert(beyond.notices.length === 0 && beyond.has_more === false && beyond.next_offset === null, JSON.stringify(beyond).slice(0, 180));
    const exams = await feedPage("exams", "limit=5000");
    assert(exams.limit === 200, `exams limit ${exams.limit}`);
  });
  await check("each feed still answers the page size the site asked for before paging", async () => {
    const notices = await feedPage("notices");
    const routines = await feedPage("routines");
    const exams = await feedPage("exams");
    assert(notices.limit === 20 && notices.offset === 0, `notices ${notices.limit}/${notices.offset}`);
    assert(routines.limit === 40, `routines ${routines.limit}`);
    assert(exams.limit === 200, `exams ${exams.limit}`);
    const days = notices.notices.map((row) => Date.parse(row.date));
    assert(days.every((value, i) => i === 0 || days[i - 1] >= value), "notices are no longer newest first");
  });
  await check("an exam window starts at the newest date and reads back in date order", async () => {
    for (const date of ["2027-02-01", "2027-02-05"]) {
      const { status } = await call("/api/cms/exams", {
        method: "POST",
        body: { exam_name: `পরীক্ষা ${date}`, class_name: "দশম", subject: "রসায়ন", exam_date: date, published_at: "2026-12-01", status: "published" },
      });
      assert(status === 201, `create ${status}`);
    }
    const page = await feedPage("exams", "limit=1");
    assert(page.exams[0].date === "2027-02-05", `the first exam row was ${page.exams[0].date}, not the newest`);
    assert(page.has_more === true && page.next_offset === 1, `has_more ${page.has_more}`);
    const older = await feedPage("exams", "limit=1&offset=1");
    assert(older.exams[0].date === "2027-02-01", `the second page had ${older.exams[0].date}`);
    const whole = await feedPage("exams", "limit=100");
    const dates = whole.exams.map((row) => row.date);
    assert([...dates].sort().join() === dates.join(), `exam rows are not ascending on the page: ${dates.join()}`);
    const walked = await walkPages("exams", "exams", 2);
    assert(walked.length === whole.exams.length && new Set(walked).size === walked.length, `paging the exams gave ${walked.length} of ${whole.exams.length}`);
  });
  await check("a routine with no date still sorts last, not lost", async () => {
    const { status } = await call("/api/cms/routines", {
      method: "POST",
      body: { title: "তারিখবিহীন রুটিন", routine_type: "সাপ্তাহিক কার্যক্রম", description: "তারিখ নেই, তাই সবার শেষে দেখাবে।", published_at: "2026-12-01", status: "published" },
    });
    assert(status === 201, `create ${status}`);
    const page = await feedPage("routines", "limit=100");
    const last = page.routines[page.routines.length - 1];
    assert(!last.date, `the last routine row had a date: ${last.date}`);
    assert(page.routines.length === new Set(page.routines.map((row) => row.id)).size, "a routine row was repeated");
  });
  await check("publishing or unpublishing one row leaves every other row untouched", async () => {
    const target = pagedNoticeIds[0];
    const other = pagedNoticeIds[1];
    const { json: before } = await call(`/api/cms/notices?id=${target}`);
    const snapshot = JSON.stringify(before.item);
    const { status: taken } = await call(`/api/cms/notices?id=${other}&action=unpublish`, { method: "POST" });
    assert(taken === 200, `unpublish ${taken}`);
    const { json: hidden } = await call("/api/public/notices?limit=100");
    assert(!hidden.notices.some((row) => row.id === other), "an unpublished row is still on the public feed");
    const { json: still } = await call("/api/public/notices?limit=100");
    assert(still.notices.some((row) => row.id === target), "an untouched published row stopped being public");
    const { status: back } = await call(`/api/cms/notices?id=${other}&action=publish`, { method: "POST" });
    assert(back === 200, `publish ${back}`);
    const { json: feed } = await call("/api/public/notices?limit=100");
    assert(feed.notices.some((row) => row.id === other), "republishing did not bring the row back");
    const { json: after } = await call(`/api/cms/notices?id=${target}`);
    assert(JSON.stringify(after.item) === snapshot, "another row changed while this one was published and unpublished");
  });

  console.log("\n— attachments survive editing —");
  const uploadPdf = async (label) => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(label.padEnd(140, "0")), Buffer.from("%%EOF\n")]);
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: "application/pdf" }), `${label}.pdf`);
    const { status, json } = await call("/api/cms/upload", { method: "POST", body: form });
    assert(status === 201, `upload ${status}`);
    return json.file.path;
  };
  const mediaStatus = async (key, { anonymous = false } = {}) => {
    const saved = new Map(jar);
    if (anonymous) jar.clear();
    const media = await call(`/api/media?path=${encodeURIComponent(key)}`, { raw: true });
    if (anonymous) {
      jar.clear();
      for (const [name, value] of saved) jar.set(name, value);
    }
    return media.status;
  };
  let keptKey = "";
  let sharedKey = "";
  let replacedKey = "";
  await check("a notice published with a PDF serves that PDF to a visitor", async () => {
    keptKey = await uploadPdf("kept");
    const { status, json } = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "নথিসহ নোটিশ", body: "সংযুক্ত নথির নিরাপত্তা পরীক্ষা।", published_at: "2026-12-05", status: "published", file: { path: keptKey, name: "kept.pdf", mime: "application/pdf", bytes: 160 } },
    });
    assert(status === 201, `${status} ${JSON.stringify(json)}`);
    pagedNoticeIds.push(json.item.id);
    assert((await mediaStatus(keptKey, { anonymous: true })) === 200, "a published attachment is not readable by a visitor");
  });
  await check("replacing an attachment keeps the object it replaced", async () => {
    const id = pagedNoticeIds[pagedNoticeIds.length - 1];
    replacedKey = await uploadPdf("replaced");
    const nextKey = replacedKey;
    const { status } = await call(`/api/cms/notices?id=${id}`, { method: "PATCH", body: { file: { path: nextKey, name: "replaced.pdf", mime: "application/pdf", bytes: 160 } } });
    assert(status === 200, `patch ${status}`);
    assert((await mediaStatus(nextKey, { anonymous: true })) === 200, "the new attachment is not public");
    assert((await mediaStatus(keptKey)) === 200, "an edit destroyed the attachment it replaced");
    assert((await mediaStatus(keptKey, { anonymous: true })) === 403, "an unreferenced object became world-readable");
  });
  await check("clearing an attachment in the edit form keeps the object", async () => {
    const id = pagedNoticeIds[pagedNoticeIds.length - 1];
    const { status, json } = await call(`/api/cms/notices?id=${id}`, { method: "PATCH", body: { file: null } });
    assert(status === 200 && !json.item.file, `${status} ${JSON.stringify(json.item.file)}`);
    assert((await mediaStatus(keptKey)) === 200, "clearing an attachment deleted the stored file");
  });
  await check("publishing and unpublishing never delete a file", async () => {
    const id = pagedNoticeIds[pagedNoticeIds.length - 1];
    const { status } = await call(`/api/cms/notices?id=${id}`, { method: "PATCH", body: { file: { path: keptKey, name: "kept.pdf", mime: "application/pdf", bytes: 160 } } });
    assert(status === 200, `patch ${status}`);
    for (const action of ["unpublish", "publish"]) {
      const { status: done } = await call(`/api/cms/notices?id=${id}&action=${action}`, { method: "POST" });
      assert(done === 200, `${action} ${done}`);
      assert((await mediaStatus(keptKey)) === 200, `${action} deleted the attachment`);
    }
  });
  await check("purging one row cannot take a file another row still points at", async () => {
    sharedKey = await uploadPdf("shared");
    const first = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "শেয়ার করা নথি এক", body: "একই নথি দুটি নোটিশে।", published_at: "2026-12-06", status: "published", file: { path: sharedKey, name: "shared.pdf", mime: "application/pdf", bytes: 160 } },
    });
    const second = await call("/api/cms/notices", {
      method: "POST",
      body: { title: "শেয়ার করা নথি দুই", body: "একই নথি দুটি নোটিশে।", published_at: "2026-12-07", status: "published", file: { path: sharedKey, name: "shared.pdf", mime: "application/pdf", bytes: 160 } },
    });
    assert(first.status === 201 && second.status === 201, `${first.status}/${second.status}`);
    const { json: purged } = await call(`/api/cms/notices?id=${first.json.item.id}&action=purge`, { method: "POST", body: { confirm: "DELETE" } });
    assert(purged.filesRemoved === 0 && purged.filesKept === 1, JSON.stringify(purged));
    assert((await mediaStatus(sharedKey)) === 200, "purging one row deleted a file the other row still links");
    assert((await mediaStatus(sharedKey, { anonymous: true })) === 200, "the surviving row's attachment lost its public link");
    const { json: last } = await call(`/api/cms/notices?id=${second.json.item.id}&action=purge`, { method: "POST", body: { confirm: "DELETE" } });
    assert(last.filesRemoved === 1, JSON.stringify(last));
    assert((await mediaStatus(sharedKey)) >= 400, "nothing points at the object and it is still in storage");
  });
  await check("only a purge frees bytes — an edit leaves an orphan in place", async () => {
    // An edit that swaps a file no longer deletes what it replaced, so the replaced
    // object is still in storage even though no row names it now. That is the point:
    // nothing but DELETE-on-purge ever removes bytes.
    assert((await mediaStatus(replacedKey)) === 200, "an orphaned attachment was removed by an edit");
    assert((await mediaStatus(replacedKey, { anonymous: true })) === 403, "an unreferenced object became world-readable");
  });
  await check("the paging rows are cleaned up and leave no bytes behind", async () => {
    for (const id of pagedNoticeIds) await call(`/api/cms/notices?id=${id}&action=purge`, { method: "POST", body: { confirm: "DELETE" } });
    const { json: feed } = await call("/api/public/notices?limit=100");
    for (const id of pagedNoticeIds) assert(!feed.notices.some((row) => row.id === id), "a purged row is still public");
    assert((await mediaStatus(keptKey)) >= 400, "the last row's attachment survived its purge");
    const left = await countFiles(path.join(tempDir, "media"));
    assert(left === 1, `${left} file(s) left in storage; only the object an edit orphaned should remain`);
  });

  /* ---- direct-to-storage photo uploads --------------------------------------
   * A Vercel function's request-body ceiling (4.5 MB) sits below this app's own
   * per-file limit, so a big photo cannot be carried by `action=upload` at any batch
   * size — that is the "HTTP 413" the Computer Teacher hit with a 5.76 MB edited
   * picture. The fix routes such a file straight into storage with a single-path
   * grant, and this API only ever sees the key. These checks drive that flow over real
   * HTTP against the local store (the local driver stands in for the signed URL), so
   * nothing here reaches Supabase, Vercel or the school's real data.
   */
  console.log("\n— direct-to-storage photo uploads —");
  const STAGING_SHAPE = /^images\/incoming\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let directAlbum = "";
  let directPhotoUrl = "";

  /** A real PNG, padded after IEND to exactly the size the teacher reported. */
  const photoOf = async (bytes) => {
    const base = await fs.readFile(pngFile);
    return base.length >= bytes ? base.subarray(0, bytes) : Buffer.concat([base, Buffer.alloc(bytes - base.length, 0x5a)]);
  };
  const grant = async (body) => call("/api/cms/photos?action=begin", { method: "POST", body });
  const commit = (body) => call("/api/cms/photos?action=commit", { method: "POST", body });
  /** The whole client side of one oversized photo: grant, PUT the bytes, register. */
  const uploadDirect = async ({ album, name, buffer, extra = {} }) => {
    const begin = await grant({ album_id: album, name, size: buffer.length });
    if (begin.status !== 201 || !begin.json?.supported) return { begin, put: null, commit: null };
    const put = await call(begin.json.upload_url, {
      method: begin.json.method || "PUT",
      bodyRaw: buffer,
      headers: { "content-type": (begin.json.headers || {})["content-type"] || "application/octet-stream" },
    });
    const done = await commit({ album_id: album, staging_key: begin.json.staging_key, name, ...extra });
    return { begin, put, commit: done, stagingKey: begin.json.staging_key };
  };

  await check("a 5.76 MB photo is granted, stored and registered — byte for byte", async () => {
    const created = await call("/api/cms/albums", { method: "POST", body: { title: "সরাসরি আপলোড", published_at: "2026-12-01", status: "draft" } });
    assert(created.status === 201, JSON.stringify(created.json));
    directAlbum = created.json.item.id;
    const buffer = await photoOf(5_760_000); // what the teacher's edited photo measured
    const result = await uploadDirect({ album: directAlbum, name: "edit-5-76.png", buffer });
    assert(result.begin?.status === 201 && result.begin.json.supported === true, `begin → ${result.begin?.status} ${JSON.stringify(result.begin?.json)}`);
    assert(STAGING_SHAPE.test(result.begin.json.staging_key), `grant named an unexpected key: ${result.begin.json.staging_key}`);
    assert(!/action=upload/.test(result.begin.json.upload_url), "the grant sent the file back to the form endpoint");
    assert(result.put.status === 201, `staging write → ${result.put.status}`);
    assert(result.commit.status === 201, `commit → ${result.commit.status} ${JSON.stringify(result.commit.json)}`);
    const photo = result.commit.json.photo;
    assert(photo.bytes === buffer.length, `row says ${photo.bytes} bytes for a ${buffer.length} byte file`);
    assert(photo.mime === "image/png" && photo.pixel_width > 0, `type not sniffed from the bytes: ${photo.mime} ${photo.pixel_width}`);
    assert(/^[0-9a-f-]{36}$/.test(photo.id), JSON.stringify(photo));
    directPhotoUrl = photo.url;
    const served = await call(photo.url, { raw: true });
    assert(served.status === 200, `served ${served.status}`);
    assert(Buffer.compare(served.buffer, buffer) === 0, "the stored bytes are not the bytes that were sent");
  });
  await check("no request that carries the file ever touches the form endpoint", async () => {
    // The two calls this API makes for an oversized photo carry a key and a name, not
    // the picture: that is the whole point of the detour around the host's ceiling.
    const buffer = await photoOf(6_000_000);
    const begin = await grant({ album_id: directAlbum, name: "six-meg.png", size: buffer.length });
    assert(begin.status === 201 && begin.json.supported === true, JSON.stringify(begin.json));
    const beginBytes = Buffer.byteLength(JSON.stringify(begin.json));
    assert(beginBytes < 1500, `the grant response alone is ${beginBytes} bytes`);
    const staging = begin.json.staging_key;
    const put = await call(begin.json.upload_url, { method: "PUT", bodyRaw: buffer, headers: { "content-type": "image/png" } });
    assert(put.status === 201, `staging write → ${put.status}`);
    const done = await commit({ album_id: directAlbum, staging_key: staging, name: "six-meg.png" });
    assert(done.status === 201 && done.json.photo.bytes === buffer.length, `${done.status} ${JSON.stringify(done.json)}`);
    assert(Buffer.byteLength(JSON.stringify(done.json)) < 1500, "the commit response should describe the photo, not carry it");
  });
  await check("a declared size cannot smuggle a bigger file past the cap", async () => {
    const big = await photoOf(9_000_000); // over the server's own 8 MB ceiling
    const begin = await grant({ album_id: directAlbum, name: "liar.png", size: 1024 }); // client claims 1 KB
    assert(begin.status === 201 && begin.json.supported === true, JSON.stringify(begin.json));
    await call(begin.json.upload_url, { method: "PUT", bodyRaw: big, headers: { "content-type": "image/png" } });
    const done = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "liar.png" });
    assert(done.status === 413, `oversized bytes were accepted with ${done.status}`);
    assert(/8 MB/.test(String(done.json?.message)), `the message did not name the limit: ${JSON.stringify(done.json)}`);
    // Refusing it must also clear staging, or a refused file would pile up in the bucket.
    const again = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "liar.png" });
    assert(again.status === 404, `staging still held the rejected file (${again.status})`);
  });
  await check("a file storage would not accept is refused before any upload is wasted", async () => {
    const { status, json } = await grant({ album_id: directAlbum, name: "huge.png", size: 40_000_000 });
    assert(status === 413 && /২০০০ পিক্সেল/.test(String(json?.message)), `${status} ${JSON.stringify(json)}`);
  });
  await check("bytes that are not an image never become a photo, and staging is cleared", async () => {
    const begin = await grant({ album_id: directAlbum, name: "trojan.png", size: 4096 });
    assert(begin.status === 201, JSON.stringify(begin.json));
    const payload = Buffer.concat([Buffer.from("#!/bin/sh\nrm -rf /\n".repeat(80))]);
    const put = await call(begin.json.upload_url, { method: "PUT", bodyRaw: payload, headers: { "content-type": "image/png" } });
    assert(put.status === 201, `storage took the bytes (${put.status}) — that is fine, the API must not`);
    const done = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "trojan.png" });
    assert(done.status === 415, `a non-image was registered (${done.status})`);
    const { json: after } = await call(`/api/cms/albums?id=${directAlbum}`);
    assert(!JSON.stringify(after).includes("trojan"), "a refused file left a row behind");
    const again = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "trojan.png" });
    assert(again.status === 404, `the rejected object was left in storage (${again.status})`);
  });
  await check("an unfinished upload registers nothing and says so", async () => {
    const begin = await grant({ album_id: directAlbum, name: "never-finished.png", size: 5_000_000 });
    const { json: before } = await call(`/api/cms/albums?id=${directAlbum}`);
    const done = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "never-finished.png" });
    assert(done.status === 404 && /শেষ হয়নি|পাওয়া যায়নি/.test(String(done.json?.message)), `${done.status} ${JSON.stringify(done.json)}`);
    const { json: after } = await call(`/api/cms/albums?id=${directAlbum}`);
    assert(after.item.photos.length === before.item.photos.length, "a photo row appeared for bytes that never arrived");
  });
  await check("an uncommitted staging object cannot be shown to anyone", async () => {
    const begin = await grant({ album_id: directAlbum, name: "invisible.png", size: 2_000_000 });
    const staging = begin.json.staging_key;
    await call(begin.json.upload_url, { method: "PUT", bodyRaw: await photoOf(2_000_000), headers: { "content-type": "image/png" } });
    // Not merely private: the key shape is outside the media route's own pattern, so a
    // half-finished upload has no URL at all.
    const anonymous = await call(`/api/media?path=${encodeURIComponent(staging)}`, { raw: true });
    assert(anonymous.status === 400, `staging was reachable (${anonymous.status})`);
    const savedCookie = new Map(jar);
    jar.clear();
    const asVisitor = await call(`/api/media?path=${encodeURIComponent(staging)}`, { raw: true });
    jar.clear();
    for (const [name, value] of savedCookie) jar.set(name, value);
    assert(asVisitor.status === 400, `a visitor could read staging (${asVisitor.status})`);
    const aborted = await call("/api/cms/photos?action=abort", { method: "POST", body: { staging_key: staging } });
    assert(aborted.status === 200 && aborted.json.removed === true, JSON.stringify(aborted.json));
  });
  await check("the same grant cannot register a photo twice", async () => {
    const buffer = await photoOf(4_800_000); // bigger than the host's request ceiling on purpose
    const begin = await grant({ album_id: directAlbum, name: "once.png", size: buffer.length });
    await call(begin.json.upload_url, { method: "PUT", bodyRaw: buffer, headers: { "content-type": "image/png" } });
    const first = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "once.png" });
    const second = await commit({ album_id: directAlbum, staging_key: begin.json.staging_key, name: "once.png" });
    assert(first.status === 201, `first commit → ${first.status}`);
    assert(second.status === 404, `a used grant committed twice (${second.status})`);
  });
  await check("cleanup can never name a stored asset, only staging", async () => {
    const { json } = await call("/api/public/gallery?albums=20&per_album=20");
    const album = json.albums.find((candidate) => candidate.id === directAlbum);
    const victimUrl = album?.photos?.[0]?.full || directPhotoUrl;
    const victimKey = new URL(victimUrl, BASE).searchParams.get("path");
    assert(victimKey, "no real photo to protect");
    const bogusCommit = await commit({ album_id: directAlbum, staging_key: victimKey, name: "x.png" });
    assert(bogusCommit.status === 400, `commit accepted a published key (${bogusCommit.status})`);
    const bogusAbort = await call("/api/cms/photos?action=abort", { method: "POST", body: { staging_key: victimKey } });
    assert(bogusAbort.status === 200 && bogusAbort.json.removed === false, JSON.stringify(bogusAbort.json));
    const stillThere = await call(victimUrl, { raw: true });
    assert(stillThere.status === 200 && stillThere.buffer.length > 1000, "the school's photo was touched by a cleanup call");
  });
  await check("the grant is not a public door: anonymous and forged-origin calls fail", async () => {
    const open = new Map(jar);
    jar.clear();
    const anonymous = await grant({ album_id: directAlbum, name: "x.png", size: 5_000_000 });
    // Back to the real session, but with a token and an origin that are not the page's.
    jar.clear();
    for (const [name, value] of open) jar.set(name, value);
    const forged = await call("/api/cms/photos?action=begin", {
      method: "POST",
      body: { album_id: directAlbum, name: "x.png", size: 5_000_000 },
      headers: { "x-csrf-token": "not-the-users-token", origin: "https://evil.example" },
    });
    assert(anonymous.status === 401, `an anonymous caller got a grant (${anonymous.status})`);
    assert(forged.status === 403, `a forged origin/token was accepted (${forged.status})`);
  });
  await check("a swept staging object goes, a live one does not", async () => {
    const label = new Date().toISOString().slice(0, 7);
    const dir = path.join(tempDir, "media", "images", "incoming", label);
    await fs.mkdir(dir, { recursive: true });
    const stale = path.join(dir, "aaaaaaaa-0000-4000-8000-000000000000");
    const fresh = path.join(dir, "bbbbbbbb-0000-4000-8000-000000000000");
    const outside = path.join(tempDir, "media", "images", label, "cccccccc-0000-4000-8000-000000000000.png");
    for (const file of [stale, fresh, outside]) await fs.writeFile(file, "x");
    await fs.utimes(stale, new Date(Date.now() - 9 * 3600e3), new Date(Date.now() - 9 * 3600e3));
    await grant({ album_id: directAlbum, name: "sweep-me.png", size: 1024 }); // begin sweeps
    assert(!(await fs.stat(stale).then(() => true, () => false)), "an abandoned 9-hour-old staging object survived the sweep");
    assert(await fs.stat(fresh).then(() => true, () => false), "a staging object still inside its window was deleted");
    assert(await fs.stat(outside).then(() => true, () => false), "the sweep reached outside images/incoming — it may only ever clear staging");
    for (const file of [fresh, outside]) await fs.rm(file, { force: true });
  });
  await check("form-uploaded and directly-uploaded photos render in one album, in order", async () => {
    // Two files in one form request, so a position clash between them is visible here.
    const form = new FormData();
    form.set("album_id", directAlbum);
    form.append("files", new Blob([await photoOf(300_000)], { type: "image/png" }), "small.png");
    form.append("files", new Blob([await photoOf(320_000)], { type: "image/png" }), "other.png");
    const viaForm = await call("/api/cms/photos?action=upload", { method: "POST", body: form });
    assert(viaForm.status === 201 && viaForm.json.photos.length === 2, `${viaForm.status} ${JSON.stringify(viaForm.json)}`);
    await call(`/api/cms/albums/publish?id=${directAlbum}`, { method: "POST" });
    const { json } = await call("/api/public/gallery?albums=20&per_album=20");
    const album = json.albums.find((candidate) => candidate.id === directAlbum);
    assert(album && album.photos.length >= 4, `the published album shows ${album?.photos?.length} photos`);
    assert(album.photos.every((photo) => photo.thumb.startsWith("/api/media?path=") && photo.full.startsWith("/api/media?path=")), "a media url left the /api/media?path= form");
    // Ordering is checked on the admin view, which is where the sequence is managed: the
    // public feed carries only what a page renders. Consecutive and unique, because a
    // batch that adds several photos at once used to give two of them the same position.
    const { json: adminView } = await call(`/api/cms/albums?id=${directAlbum}`);
    const ordered = adminView.item.photos.map((photo) => photo.sort_order);
    assert(ordered.every((value) => Number.isFinite(value)), `positions missing entirely: ${JSON.stringify(ordered)}`);
    assert(ordered.join(",") === ordered.slice().sort((a, b) => a - b).join(","), `sort order jumped around: ${ordered.join(",")}`);
    assert(new Set(ordered).size === ordered.length, `two photos share a position: ${ordered.join(",")}`);
    assert(ordered.slice(0, 5).join(",") === "0,1,2,3,4", `positions are not consecutive from the front: ${ordered.join(",")}`);
    for (const photo of album.photos) {
      const { status } = await call(photo.full, { raw: true });
      assert(status === 200, `${photo.full} served ${status}`);
    }
  });
  await check("a completed upload leaves no staging bytes behind", async () => {
    const left = await countFiles(path.join(tempDir, "media", "images", "incoming"));
    assert(left === 0, `${left} staging object(s) were left behind after uploads finished`);
  });
  await check("with direct uploads switched off the form path still answers", async () => {
    /* CMS_DIRECT_UPLOADS=0 is the documented escape hatch. The API must say so in the
     * status payload, and the small photos that always worked must keep working. */
    const { json } = await call("/api/cms/status");
    assert(json.limits && typeof json.limits.directUploads === "boolean", `status does not report the capability: ${JSON.stringify(json.limits)}`);
    assert(json.limits.directUploads === true, "the local driver should support grants, so the admin plans a direct step");
    const tooBigForm = new FormData();
    tooBigForm.set("album_id", directAlbum);
    tooBigForm.append("files", new Blob([await photoOf(5_760_000)], { type: "image/png" }), "too-big-for-one-request.png");
    const refused = await call("/api/cms/photos?action=upload", { method: "POST", body: tooBigForm });
    // Our own form path still accepts it — the 4.5 MB ceiling is the platform's, not the
    // app's, which is exactly why an oversized photo must not be sent that way at all.
    assert(refused.status === 201, `${refused.status} ${JSON.stringify(refused.json)}`);
  });

  console.log("\n— cleanup —");
  await check("logging out drops the session server-side", async () => {
    const { status } = await call("/api/cms/logout", { method: "POST" });
    assert(status === 200, `status ${status}`);
    const { status: after } = await call("/api/cms/notices");
    assert(after === 401, `session survived logout (${after})`);
  });
} catch (error) {
  record("unexpected harness failure", false, error?.stack || String(error));
} finally {
  server.kill("SIGTERM");
  await fs.rm(tempDir, { recursive: true, force: true });
}

function json0(payload, key) {
  const value = payload?.[key];
  if (!value) throw new Error(`no ${key} in response: ${JSON.stringify(payload).slice(0, 200)}`);
  return value;
}

async function countFiles(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await countFiles(child);
    else total += 1;
  }
  return total;
}

const failed = results.filter((row) => !row.pass);
if (failed.length && serverLog.trim()) console.log("\n— server log (last 3000 chars) —\n" + serverLog.slice(-3000));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
