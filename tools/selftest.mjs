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

const call = async (pathname, { method = "GET", body, headers = {}, raw = false } = {}) => {
  const isForm = body instanceof FormData;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(jar.get("rahs_csrf") && ["POST", "PATCH", "DELETE"].includes(method) ? { "x-csrf-token": jar.get("rahs_csrf") } : {}),
      ...(isForm ? {} : body ? { "content-type": "application/json" } : {}),
      origin: BASE,
      ...headers,
    },
    ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}),
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
    // The older path-style URL must keep resolving, and the feed must hand the browser
    // the routable query form (Vercel only routes /api/<group>/<one segment>).
    const legacy = await call(`/api/media/${pdfPath}`, { raw: true });
    assert(legacy.status === 200, `legacy media path ${legacy.status}`);
    // The URL handed to the browser — by the admin screen and, when the notice is
    // published, by the public feed — must be the routable query form.
    const { json: adminRow } = await call(`/api/cms/notices?id=${noticeId}`);
    assert(adminRow.item.file.url.startsWith("/api/media?path="), `admin attachment url ${JSON.stringify(adminRow.item.file)}`);
    const { json: withFile } = await call("/api/public/notices");
    const feedRow = withFile.notices.find((candidate) => candidate.id === noticeId);
    if (feedRow) assert(String(feedRow.file.url).startsWith("/api/media?path="), `feed attachment url ${JSON.stringify(feedRow.file)}`);
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
